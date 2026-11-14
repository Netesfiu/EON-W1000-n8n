import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ImportError } from '../utils/log.js';
import { QUARTER } from '../utils/time.js';
import type { Interval } from '../eon/types.js';
import type { SumRow } from '../eon/aggregate.js';
import type { EmailObject } from '../r2/client.js';

type StoredInterval = Interval & { receivedMs: number };
export type ParsedAttachment = { digest: string; intervals: readonly Interval[]; meterIdentity?: string };
export type MergeCounts = { added: number; duplicates: number; corrected: number; older: number; duplicateReports: number };

const schema = `
  CREATE TABLE IF NOT EXISTS receipts (
    key TEXT PRIMARY KEY, etag TEXT NOT NULL, received_ms INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS reports (
    digest TEXT PRIMARY KEY, key TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS intervals (
    direction TEXT NOT NULL CHECK (direction IN ('+A', '-A')),
    start_ms INTEGER NOT NULL, original_timestamp TEXT NOT NULL,
    original_kwh TEXT NOT NULL, micro_kwh INTEGER NOT NULL CHECK (micro_kwh >= 0),
    received_ms INTEGER NOT NULL, PRIMARY KEY (direction, start_ms)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS confirmed (
    direction TEXT NOT NULL, start_ms INTEGER NOT NULL,
    sum_micros INTEGER NOT NULL, PRIMARY KEY (direction, start_ms)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS targets (
    name TEXT PRIMARY KEY, identity TEXT NOT NULL
  ) STRICT;
`;
const intervalSelect = `SELECT direction, start_ms AS startMs, original_timestamp AS originalTimestamp,
  original_kwh AS originalKwh, micro_kwh AS microKwh, received_ms AS receivedMs FROM intervals`;

export class Store {
  private readonly db: DatabaseSync;
  private lock?: DatabaseSync;

  constructor(directory: string, dryRun: boolean) {
    const file = join(directory, 'importer.sqlite');
    if (!dryRun) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.lock = new DatabaseSync(join(directory, 'run-lock.sqlite'));
      try {
        this.lock.exec('BEGIN EXCLUSIVE');
      } catch {
        this.lock.close();
        throw new ImportError('Another importer is using this state directory or the run lock is unavailable');
      }
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dryRun ? ':memory:' : file);
      this.db = db;
      this.db.exec(schema);
      if (dryRun && existsSync(file)) {
        const source = pathToFileURL(file);
        source.searchParams.set('mode', 'ro');
        this.db.prepare('ATTACH DATABASE ? AS saved').run(source.href);
        this.db.exec('BEGIN');
        for (const table of ['receipts', 'reports', 'intervals', 'confirmed', 'targets']) {
          this.db.exec(`INSERT INTO main.${table} SELECT * FROM saved.${table}`);
        }
        this.db.exec('COMMIT; DETACH DATABASE saved');
      }
    } catch {
      db?.close();
      this.lock?.close();
      throw new ImportError('Cannot open importer state');
    }
  }

  hasEmail({ key, etag, receivedMs }: EmailObject): boolean {
    return !!this.db.prepare('SELECT 1 FROM receipts WHERE key = ? AND etag = ? AND received_ms = ?')
      .get(key, etag, receivedMs);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  merge(object: EmailObject, attachments: readonly ParsedAttachment[]): MergeCounts {
    const counts = emptyCounts();
    const get = this.db.prepare(`${intervalSelect} WHERE direction = ? AND start_ms = ?`);
    const put = this.db.prepare(`
      INSERT INTO intervals VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(direction, start_ms) DO UPDATE SET
        original_timestamp = excluded.original_timestamp, original_kwh = excluded.original_kwh,
        micro_kwh = excluded.micro_kwh, received_ms = excluded.received_ms
    `);
    const report = this.db.prepare('SELECT key FROM reports WHERE digest = ?');
    const saveReport = this.db.prepare('INSERT OR IGNORE INTO reports VALUES (?, ?)');

    return this.transaction(() => {
      const emailValues = new Map<string, number>();
      for (const attachment of attachments) {
        if (attachment.meterIdentity) this.bind('meter', attachment.meterIdentity);
        const priorReport = report.get(attachment.digest);
        if (priorReport) counts.duplicateReports++;
        for (const interval of attachment.intervals) {
          const { direction, startMs, originalTimestamp, originalKwh, microKwh } = interval;
          if (!['+A', '-A'].includes(direction) || !Number.isSafeInteger(startMs) ||
            startMs % QUARTER !== 0 || !Number.isSafeInteger(microKwh) || microKwh < 0) {
            throw new ImportError('Adapter returned an invalid quarter-hour measurement');
          }

          const id = `${direction}/${startMs}`;
          const previous = emailValues.get(id);
          if (previous !== undefined && previous !== microKwh) {
            throw new ImportError('Email contains conflicting measurements for the same quarter-hour and direction');
          }
          emailValues.set(id, microKwh);

          // Byte-identical attachments in other emails are copies of a known report.
          if (priorReport && priorReport.key !== object.key) {
            counts.duplicates++;
            continue;
          }

          const old = get.get(direction, startMs) as StoredInterval | undefined;
          if (!old) counts.added++;
          else if (old.microKwh === microKwh) counts.duplicates++;
          else if (old.receivedMs > object.receivedMs) counts.older++;
          else if (old.receivedMs === object.receivedMs) {
            throw new ImportError('Conflicting measurements share the same R2 modification time');
          } else counts.corrected++;

          if (!old || old.receivedMs <= object.receivedMs) {
            put.run(direction, startMs, originalTimestamp, originalKwh, microKwh, object.receivedMs);
          }
        }
        saveReport.run(attachment.digest, object.key);
      }
      this.db.prepare('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?)')
        .run(object.key, object.etag, object.receivedMs);
      return counts;
    });
  }

  measurements(): Iterable<Interval> {
    return this.db.prepare(intervalSelect).iterate() as Iterable<Interval>;
  }

  pending(rows: readonly SumRow[], replay: boolean): SumRow[] {
    const confirmed = new Map<string, number>();
    for (const row of this.db.prepare('SELECT * FROM confirmed').iterate()) {
      confirmed.set(`${row.direction}/${row.start_ms}`, Number(row.sum_micros));
    }
    return rows.filter((row) => replay || confirmed.get(`${row.direction}/${row.startMs}`) !== row.sumMicros);
  }

  invalidate(rows: readonly SumRow[]): void {
    const remove = this.db.prepare('DELETE FROM confirmed WHERE direction = ? AND start_ms = ?');
    this.transaction(() => {
      for (const row of rows) remove.run(row.direction, row.startMs);
    });
  }

  confirm(rows: readonly SumRow[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO confirmed VALUES (?, ?, ?)');
    this.transaction(() => {
      for (const row of rows) insert.run(row.direction, row.startMs, row.sumMicros);
    });
  }

  target(name: string): string | undefined {
    return this.db.prepare('SELECT identity FROM targets WHERE name = ?').get(name)?.identity as string | undefined;
  }

  bind(name: string, identity: string): void {
    const prior = this.target(name);
    if (prior !== undefined && prior !== identity) throw new ImportError(`State directory belongs to a different ${name} target`);
    this.db.prepare('INSERT OR IGNORE INTO targets VALUES (?, ?)').run(name, identity);
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      this.lock?.close();
    }
  }
}

export function emptyCounts(): MergeCounts {
  return { added: 0, duplicates: 0, corrected: 0, older: 0, duplicateReports: 0 };
}
