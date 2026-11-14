import { expect, it } from 'vitest';
import { hourlySums } from '../src/eon/aggregate.js';
import { interval } from '../src/eon/types.js';
import { budapestInstant, HOUR } from '../src/utils/time.js';

const fall = { year: 2026, month: 10, day: 25, hour: 2, minute: 15 };

it('normalizes winter and summer timestamps', () => {
  expect(budapestInstant({ ...fall, month: 1 })).toBe(Date.UTC(2026, 0, 25, 1, 15));
  expect(budapestInstant({ ...fall, month: 7 })).toBe(Date.UTC(2026, 6, 25, 0, 15));
  expect(() => budapestInstant({ ...fall, day: 32 })).toThrow('valid Budapest');
});

it('rejects nonexistent and unresolved ambiguous wall times', () => {
  expect(() => budapestInstant({ ...fall, month: 3, day: 29 })).toThrow('Nonexistent');
  expect(() => budapestInstant(fall)).toThrow('Ambiguous');
  expect(() => budapestInstant(fall, 180)).toThrow('disagrees');
});

it('aggregates each repeated autumn hour independently in UTC', () => {
  const intervals = [120, 60].flatMap((offsetMinutes) => [0, 15, 30, 45].map((minute) => interval({
    direction: '-A', wallTime: { ...fall, minute }, originalTimestamp: 'fixture',
    kwh: '0.125', label: 'start', offsetMinutes,
  })));
  const { rows, incompleteHours } = hourlySums(intervals);
  expect(incompleteHours).toBe(0);
  expect(rows).toEqual([
    { direction: '-A', startMs: Date.UTC(2026, 9, 25), sumMicros: 500_000 },
    { direction: '-A', startMs: Date.UTC(2026, 9, 25) + HOUR, sumMicros: 1_000_000 },
  ]);
});

it('subtracts elapsed time across the spring gap for end-labeled intervals', () => {
  const reading = interval({
    direction: '+A', wallTime: { ...fall, month: 3, day: 29, hour: 3, minute: 0 },
    originalTimestamp: 'fixture', kwh: '0.1', label: 'end',
  });
  expect(reading.startMs).toBe(Date.UTC(2026, 2, 29, 0, 45));
  expect(hourlySums([reading])).toEqual({ rows: [], incompleteHours: 1 });
});
