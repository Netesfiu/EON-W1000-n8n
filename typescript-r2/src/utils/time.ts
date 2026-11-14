import { ImportError } from './log.js';

export const HOUR = 3_600_000;
export const QUARTER = HOUR / 4;
export const ZONE = 'Europe/Budapest';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function wallTimeAt(instant: number): number {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

export function budapestInstant(time: WallTime, offsetMinutes?: number): number {
  const { year, month, day, hour, minute } = time;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (![year, month, day, hour, minute].every(Number.isInteger) ||
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day || check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute || minute % 15 !== 0) {
    throw new ImportError('Expected a valid Budapest wall time on a 15-minute boundary');
  }

  // Budapest offsets immediately before and after a transition are visible
  // within one day of the requested wall clock time.
  const offsets = new Set([-24, 0, 24].map((hours) => {
    const probe = wall + hours * HOUR;
    return wallTimeAt(probe) - probe;
  }));
  const matches = [...offsets].map((offset) => wall - offset)
    .filter((instant) => wallTimeAt(instant) === wall);
  if (matches.length === 0) throw new ImportError('Nonexistent Budapest wall time during spring DST transition');
  if (offsetMinutes !== undefined) {
    const match = matches.find((instant) => instant === wall - offsetMinutes * 60_000);
    if (match === undefined) throw new ImportError('Report offset disagrees with Budapest wall time');
    return match;
  }
  if (matches.length > 1) throw new ImportError('Ambiguous Budapest wall time requires the occurrence offset');
  return matches[0]!;
}
