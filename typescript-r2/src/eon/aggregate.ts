import { HOUR } from '../utils/time.js';
import { addEnergy } from './types.js';
import type { Direction, Interval } from './types.js';

export type SumRow = { direction: Direction; startMs: number; sumMicros: number };

export function hourlySums(intervals: Iterable<Interval>): { rows: SumRow[]; incompleteHours: number } {
  const hours = new Map<Direction, Map<number, { count: number; micros: number }>>([
    ['+A', new Map()], ['-A', new Map()],
  ]);
  for (const interval of intervals) {
    const bins = hours.get(interval.direction)!;
    const start = Math.floor(interval.startMs / HOUR) * HOUR;
    const bin = bins.get(start) ?? { count: 0, micros: 0 };
    bin.count++;
    bin.micros = addEnergy(bin.micros, interval.microKwh);
    bins.set(start, bin);
  }

  const rows: SumRow[] = [];
  let incompleteHours = 0;
  for (const [direction, bins] of hours) {
    let sumMicros = 0;
    for (const [startMs, bin] of [...bins].sort(([left], [right]) => left - right)) {
      if (bin.count !== 4) {
        incompleteHours++;
        continue;
      }
      sumMicros = addEnergy(sumMicros, bin.micros);
      rows.push({ direction, startMs, sumMicros });
    }
  }
  return { rows, incompleteHours };
}
