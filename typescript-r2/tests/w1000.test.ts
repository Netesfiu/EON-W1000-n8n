import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { parseWorkbook } from '../src/eon/parser.js';

function fixture(date = new Date(Date.UTC(2026, 10, 13))) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('POD_1');
  sheet.addRow(['Pod', 'Időbélyeg', ...Array.from({ length: 4 }, () =>
    ['Változó', 'Érték', 'Mértékegység']).flat()]);
  sheet.addRow(['fixture-meter', date, '-A', 0, 'kWh', '+A', 0.125, 'kWh',
    'DP_1-1:1.8.0*0', 100, 'kWh', 'DP_1-1:2.8.0*0']);
  return workbook;
}

it('reads Excel serial dates as Budapest time and matches energy by variable', async () => {
  const report = await parseWorkbook(Buffer.from(await fixture().xlsx.writeBuffer()));
  expect(report.intervals.map(({ direction, startMs, microKwh }) => [direction, startMs, microKwh])).toEqual([
    ['-A', Date.UTC(2026, 10, 12, 23), 0],
    ['+A', Date.UTC(2026, 10, 12, 23), 125_000],
  ]);
  expect(report.intervals[0]?.originalTimestamp).toBe('2026-11-13T00:00:00');
  expect(report.registers).toMatchObject([{ register: '1.8.0', originalKwh: '100' }]);
});

it('rejects ambiguous times in offset-free Excel serial dates', async () => {
  const buffer = await fixture(new Date(Date.UTC(2026, 9, 25, 2, 15))).xlsx.writeBuffer();
  await expect(parseWorkbook(Buffer.from(buffer))).rejects.toThrow('W1000 row 2: Ambiguous');
});
