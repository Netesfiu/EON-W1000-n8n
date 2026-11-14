import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hourlySums } from '../src/eon/aggregate.js';
import { publish } from '../src/home-assistant/statistics.js';
import { Store } from '../src/state/store.js';
import type { Interval } from '../src/eon/types.js';
import { firstHour, hour } from './fixtures/report.js';

let directory: string;
let store: Store;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eon-state-'));
  store = new Store(directory, false);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function object(receivedMs: number, key = String(receivedMs)) {
  return { key, etag: String(receivedMs), receivedMs, size: 1 };
}

function merge(receivedMs: number, intervals: Interval[], digest = String(receivedMs)) {
  return store.merge(object(receivedMs), [{ digest, intervals }]);
}

function rows() {
  return hourlySums(store.measurements()).rows;
}

it('merges overlaps and copies, corrects historical values and recalculates the suffix', () => {
  expect(merge(1, [...hour(0, 100_000), ...hour(1, 100_000)]).added).toBe(8);
  expect(merge(2, [...hour(1, 100_000), ...hour(2, 100_000)])).toMatchObject({ added: 4, duplicates: 4 });
  store.confirm(rows());
  expect(merge(3, hour(0, 200_000)).corrected).toBe(4);
  expect(store.pending(rows(), false).map((row) => row.sumMicros)).toEqual([800_000, 1_200_000, 1_600_000]);
  expect(merge(4, [...hour(0, 100_000), ...hour(1, 100_000)], '1').duplicateReports).toBe(1);
  expect(merge(0, hour(0, 300_000)).older).toBe(4);
  expect(rows().at(-1)?.sumMicros).toBe(1_600_000);
});

it('rolls back all changes when a report contains conflicting measurements', () => {
  expect(() => merge(1, [...hour(0, 100_000), ...hour(0, 200_000)])).toThrow('conflicting measurements');
  expect(store.hasEmail(object(1))).toBe(false);
  expect(rows()).toEqual([]);
});

it('holds a crash-safe writer lock and dry-run changes are isolated', () => {
  merge(1, hour(0, 100_000));
  expect(() => new Store(directory, false)).toThrow('run lock');
  const dryRun = new Store(directory, true);
  try {
    dryRun.merge(object(2), [{ digest: '2', intervals: hour(0, 200_000) }]);
    expect(hourlySums(dryRun.measurements()).rows[0]?.sumMicros).toBe(800_000);
    expect(rows()[0]?.sumMicros).toBe(400_000);
  } finally {
    dryRun.close();
  }
});

it('retries an unconfirmed import after reopening, including when a newer report reverts it', async () => {
  merge(1, hour(0, 100_000));
  store.confirm(rows());
  merge(2, hour(0, 200_000));
  const remote = new Map<string, number>();
  await expect(publish({ request: async () => {
    remote.set('eon:grid_import', 0.8);
    throw new Error('connection lost after write');
  } }, store, store.pending(rows(), false))).rejects.toThrow('connection lost');
  store.close();
  store = new Store(directory, false);
  expect(store.hasEmail(object(2))).toBe(true);
  merge(3, hour(0, 100_000));
  expect(store.pending(rows(), false)).toHaveLength(1);
  await publish({ request: async (command) => {
    if (command.type === 'recorder/import_statistics') {
      const [first] = command.stats as { sum: number }[];
      remote.set('eon:grid_import', first!.sum);
      return null;
    }
    return { 'eon:grid_import': [{ start: firstHour, sum: remote.get('eon:grid_import') }] };
  } }, store, store.pending(rows(), false));
  expect(remote.get('eon:grid_import')).toBe(0.4);
  expect(store.pending(rows(), false)).toEqual([]);
  expect(store.pending(rows(), true)).toHaveLength(1);
});
