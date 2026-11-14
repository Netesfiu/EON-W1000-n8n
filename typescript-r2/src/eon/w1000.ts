import type { Workbook } from 'exceljs';
import { ImportError } from '../utils/log.js';
import { interval } from './types.js';
import type { Interval, RegisterReading, Report } from './types.js';

const headers = ['Pod', 'Időbélyeg', ...Array.from({ length: 4 }, () =>
  ['Változó', 'Érték', 'Mértékegység']).flat()];

export function parseW1000(workbook: Workbook): Report | undefined {
  const sheets = workbook.worksheets.filter((sheet) => /^POD_\d+$/.test(sheet.name));
  if (!sheets.length) return undefined;
  if (sheets.length !== 1) throw new ImportError('Expected a single POD in the W1000 workbook');
  const sheet = sheets[0]!;
  if (!headers.every((header, index) => sheet.getRow(1).getCell(index + 1).text.trim() === header)) return undefined;

  const intervals: Interval[] = [];
  const registers: RegisterReading[] = [];
  let meterId: string | undefined;
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    try {
      const pod = row.getCell(1).value;
      if (typeof pod !== 'string' || !pod.trim() || (meterId !== undefined && meterId !== pod.trim())) {
        throw new ImportError('Expected one meter identifier throughout the report');
      }
      meterId = pod.trim();
      const stamp = row.getCell(2).value;
      if (!(stamp instanceof Date) || !Number.isFinite(stamp.getTime()) ||
        stamp.getUTCSeconds() !== 0 || stamp.getUTCMilliseconds() !== 0) {
        throw new ImportError('Expected a quarter-hour Excel date');
      }
      // Excel serial dates store wall time. ExcelJS exposes its components in UTC.
      const originalTimestamp = stamp.toISOString().slice(0, 19);
      const wallTime = {
        year: stamp.getUTCFullYear(), month: stamp.getUTCMonth() + 1, day: stamp.getUTCDate(),
        hour: stamp.getUTCHours(), minute: stamp.getUTCMinutes(),
      };
      const seen = new Set<string>();
      for (const column of [3, 6, 9, 12]) {
        const variable = row.getCell(column).text.trim();
        const value = row.getCell(column + 1).value;
        const unit = row.getCell(column + 2).text.trim();
        if (variable === '+A' || variable === '-A') {
          if (seen.has(variable)) throw new ImportError('Repeated energy direction');
          seen.add(variable);
          if (value === null || value === '') continue;
          if (unit !== 'kWh' || !['number', 'string'].includes(typeof value)) {
            throw new ImportError('Expected numeric interval energy in kWh');
          }
          intervals.push(interval({ direction: variable, wallTime, originalTimestamp, kwh: String(value), label: 'start' }));
          continue;
        }
        const code = /(?:^|:)([12]\.8\.0)(?:\*\d+)?$/.exec(variable)?.[1];
        if ((code === '1.8.0' || code === '2.8.0') && value !== null && value !== '') {
          if (unit !== 'kWh' || !['number', 'string'].includes(typeof value)) {
            throw new ImportError('Expected numeric register reading in kWh');
          }
          registers.push({ register: code, originalTimestamp, originalKwh: String(value) });
        }
      }
      if (seen.size !== 2) throw new ImportError('Expected +A and -A interval columns');
    } catch (error) {
      if (error instanceof ImportError) throw new ImportError(`W1000 row ${number}: ${error.message}`);
      throw error;
    }
  });
  return { intervals, registers, meterId };
}
