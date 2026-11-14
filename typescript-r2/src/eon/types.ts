import { ImportError } from '../utils/log.js';
import { budapestInstant, QUARTER } from '../utils/time.js';
import type { WallTime } from '../utils/time.js';

export type Direction = '+A' | '-A';
export type Interval = {
  direction: Direction;
  startMs: number;
  originalTimestamp: string;
  originalKwh: string;
  microKwh: number;
};

export const MICRO_KWH = 1_000_000;

export function interval(input: {
  direction: Direction;
  wallTime: WallTime;
  originalTimestamp: string;
  kwh: string;
  label: 'start' | 'end';
  offsetMinutes?: number;
}): Interval {
  const value = /^(\d+)(?:[.,](\d+))?$/.exec(input.kwh.trim());
  if (!value) throw new ImportError('Expected a nonnegative decimal interval value in kWh');
  const fraction = (value[2] ?? '').replace(/0+$/, '');
  if (fraction.length > 6) throw new ImportError('Interval value exceeds six decimal places in kWh');
  const microKwh = Number(value[1]) * MICRO_KWH + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(microKwh)) throw new ImportError('Interval energy is out of range');
  const instant = budapestInstant(input.wallTime, input.offsetMinutes);
  return {
    direction: input.direction,
    startMs: instant - (input.label === 'end' ? QUARTER : 0),
    originalTimestamp: input.originalTimestamp,
    originalKwh: input.kwh,
    microKwh,
  };
}

export function addEnergy(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new ImportError('Cumulative energy is out of range');
  return sum;
}

// Optional cumulative readings stay separate from interval energy.
export type RegisterReading = {
  register: '1.8.0' | '2.8.0';
  originalTimestamp: string;
  originalKwh: string;
};

export type Report = {
  intervals: readonly Interval[];
  meterId?: string;
  registers?: readonly RegisterReading[];
};
