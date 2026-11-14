import { createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { config, options, usage } from './config.js';
import { extractWorkbooks } from './email/parser.js';
import { hourlySums } from './eon/aggregate.js';
import { eonAdapter, parseWorkbook } from './eon/parser.js';
import { addEnergy, MICRO_KWH } from './eon/types.js';
import { HomeAssistant } from './home-assistant/client.js';
import { publish } from './home-assistant/statistics.js';
import { R2 } from './r2/client.js';
import { emptyCounts, Store } from './state/store.js';
import type { ParsedAttachment } from './state/store.js';
import { errorMessage, ImportError, log } from './utils/log.js';
import { QUARTER } from './utils/time.js';

async function main(): Promise<void> {
  const cli = options(process.argv.slice(2));
  if (cli.help) {
    console.log(usage);
    return;
  }
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ImportError('Unable to load .env');
  }
  const cfg = config(process.env, cli.dryRun);
  if (!cfg.dryRun && !eonAdapter.validatedAgainstRealExport) {
    throw new ImportError('Write mode requires an adapter validated against a real E.ON export');
  }
  const store = new Store(cfg.directory, cfg.dryRun);
  const { bucket, endpoint, accessKeyId, secretAccessKey } = cfg.r2;
  const r2 = new R2(bucket, endpoint, accessKeyId, secretAccessKey);
  let ha: HomeAssistant | undefined;
  try {
    store.bind('r2', JSON.stringify([endpoint, bucket]));
    if (cfg.ha) store.bind('home-assistant', cfg.ha.url);

    const objects = await r2.list(cli.since);
    log('r2_objects_found', { count: objects.length, since: cli.since });
    const counts = emptyCounts();
    let processed = 0;
    let skipped = 0;
    let failures = 0;
    let attachmentsFound = 0;
    for (const object of objects) {
      if (!cfg.dryRun && !cli.reprocess && store.hasEmail(object)) {
        skipped++;
        continue;
      }
      let attachmentIndex: number | undefined;
      try {
        const workbooks = await extractWorkbooks(await r2.download(object));
        attachmentsFound += workbooks.length;
        log('xlsx_attachments_found', { object: object.key, count: workbooks.length });
        const attachments: ParsedAttachment[] = [];
        for (const [index, workbook] of workbooks.entries()) {
          attachmentIndex = index + 1;
          const report = await parseWorkbook(workbook);
          attachments.push({
            digest: createHash('sha256').update(workbook).digest('hex'),
            intervals: report.intervals,
            meterIdentity: report.meterId && createHash('sha256').update(report.meterId).digest('hex'),
          });
        }
        attachmentIndex = undefined;
        const result = store.merge(object, attachments);
        for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += result[key];
        processed++;
      } catch (error) {
        failures++;
        log('error', {
          object: object.key, attachment: attachmentIndex,
          message: errorMessage(error, 'Unable to process email'),
        });
      }
    }

    let start = Infinity;
    let end = -Infinity;
    const totals = { '+A': 0, '-A': 0 };
    const { rows, incompleteHours } = hourlySums((function* () {
      for (const interval of store.measurements()) {
        totals[interval.direction] = addEnergy(totals[interval.direction], interval.microKwh);
        start = Math.min(start, interval.startMs);
        end = Math.max(end, interval.startMs + QUARTER);
        yield interval;
      }
    })());
    const pending = store.pending(rows, cli.reprocess);
    log('run_summary', {
      dryRun: cfg.dryRun, processed, skipped, failures, attachmentsFound, ...counts,
      start: Number.isFinite(start) ? new Date(start).toISOString() : null,
      endExclusive: Number.isFinite(end) ? new Date(end).toISOString() : null,
      gridImportKwh: totals['+A'] / MICRO_KWH, gridExportKwh: totals['-A'] / MICRO_KWH,
      incompleteHours, pendingStatistics: pending.length,
    });
    if (failures) process.exitCode = 1;
    if (cfg.ha && pending.length) {
      ha = new HomeAssistant(cfg.ha.url, cfg.ha.token);
      await publish(ha, store, pending);
    }
  } finally {
    ha?.close();
    r2.close();
    store.close();
  }
}

main().catch((error: unknown) => {
  log('error', { message: errorMessage(error, 'Importer failed unexpectedly') });
  process.exitCode = 1;
});
