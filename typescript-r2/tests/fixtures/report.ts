import ExcelJS from 'exceljs';
import { interval } from '../../src/eon/types.js';
import type { Direction } from '../../src/eon/types.js';
import type { ReportAdapter } from '../../src/eon/parser.js';
import { HOUR, QUARTER } from '../../src/utils/time.js';

export const firstHour = Date.UTC(2026, 10, 1, 11);

// Synthetic format, deliberately unrelated to the W1000 layout.
export const fixtureAdapter: ReportAdapter = {
  validatedAgainstRealExport: false,
  parse(workbook) {
    const sheet = workbook.getWorksheet('Synthetic fixture');
    if (!sheet || sheet.getCell('A1').value !== 'test only') return;
    return {
      intervals: [interval({
        direction: '+A',
        wallTime: { year: 2026, month: 11, day: 1, hour: 12, minute: 15 },
        originalTimestamp: 'fixture timestamp',
        kwh: sheet.getCell('A2').text,
        label: 'end',
      })],
    };
  },
};

export async function workbookBytes(): Promise<Buffer> {
  const sheet = new ExcelJS.Workbook();
  sheet.addWorksheet('Synthetic fixture').addRows([['test only'], ['0,125']]);
  return Buffer.from(await sheet.xlsx.writeBuffer());
}

export function hour(index: number, microKwh: number, direction: Direction = '+A') {
  return Array.from({ length: 4 }, (_, quarter) => {
    const startMs = firstHour + index * HOUR + quarter * QUARTER;
    return {
      direction, startMs, microKwh, originalTimestamp: new Date(startMs).toISOString(),
      originalKwh: String(microKwh / 1_000_000),
    };
  });
}
