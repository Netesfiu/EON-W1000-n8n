import { MICRO_KWH } from '../eon/types.js';
import type { Direction } from '../eon/types.js';
import type { SumRow } from '../eon/aggregate.js';
import type { Store } from '../state/store.js';
import { HOUR } from '../utils/time.js';
import { ImportError, log } from '../utils/log.js';

export const series = {
  '+A': { id: 'eon:grid_import', name: 'E.ON grid import' },
  '-A': { id: 'eon:grid_export', name: 'E.ON grid export' },
} as const;

export function importRequest(direction: Direction, rows: readonly SumRow[]) {
  return {
    type: 'recorder/import_statistics',
    metadata: {
      statistic_id: series[direction].id,
      name: series[direction].name,
      source: 'eon',
      mean_type: 0,
      has_sum: true,
      unit_class: 'energy',
      unit_of_measurement: 'kWh',
    },
    stats: rows.map((row) => ({
      start: new Date(row.startMs).toISOString(),
      sum: row.sumMicros / MICRO_KWH,
    })),
  };
}

type Requester = { request(command: { type: string; [key: string]: unknown }): Promise<unknown> };

export async function publish(client: Requester, store: Store, rows: readonly SumRow[]): Promise<void> {
  for (const direction of ['+A', '-A'] as const) {
    const id = series[direction].id;
    const pending = rows.filter((row) => row.direction === direction);
    let first = 0;
    while (first < pending.length) {
      const start = pending[first]!.startMs;
      // Bound the read-back range even when the source history has gaps.
      let end = first + 1;
      while (end < pending.length && end - first < 168 && pending[end]!.startMs - start < 168 * HOUR) end++;
      const batch = pending.slice(first, end);
      const last = batch.at(-1)!.startMs;

      // A request may take effect even when its response or read-back is lost.
      // Invalidate before requesting so a later correction can safely revert it.
      store.invalidate(batch);
      await client.request(importRequest(direction, batch));
      for (let attempt = 1; ; attempt++) {
        const result = await client.request({
          type: 'recorder/statistics_during_period',
          start_time: new Date(start).toISOString(),
          end_time: new Date(last + HOUR).toISOString(),
          statistic_ids: [id],
          period: 'hour',
          types: ['sum'],
        });
        const records = (result as Record<string, { start: number; sum: number | null }[]> | null)?.[id];
        const byStart = new Map(Array.isArray(records) ? records.map(({ start, sum }) => [start, sum]) : []);
        if (batch.every((row) => byStart.get(row.startMs) === row.sumMicros / MICRO_KWH)) break;
        if (attempt === 8) throw new ImportError(`Recorder did not confirm sums for ${id}`);
        log('retry', { service: 'home-assistant', operation: 'verify statistics', statisticId: id, attempt });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      store.confirm(batch);
      log('statistics_confirmed', { statisticId: id, rows: batch.length, start: new Date(start).toISOString(), end: new Date(last + HOUR).toISOString() });
      first = end;
    }
  }
}
