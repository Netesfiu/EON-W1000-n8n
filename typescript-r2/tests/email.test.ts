import { describe, expect, it } from 'vitest';
import { extractWorkbooks, MAX_EMAIL_BYTES } from '../src/email/parser.js';
import { parseWorkbook } from '../src/eon/parser.js';
import { firstHour, fixtureAdapter, workbookBytes } from './fixtures/report.js';

const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function email(contents: Buffer[]): Buffer {
  const parts = contents.map((content) => [
    '--fixture',
    `Content-Type: ${xlsx}`,
    'Content-Disposition: attachment; filename="fixture.XLSX"',
    'Content-Transfer-Encoding: base64',
    '',
    ...content.toString('base64').match(/.{1,76}/g)!,
  ].join('\r\n'));
  return Buffer.from([
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary=fixture',
    '',
    '--fixture',
    'Content-Type: text/plain',
    '',
    'Synthetic report',
    ...parts,
    '--fixture--',
    '',
  ].join('\r\n'));
}

describe('email and workbook ingestion', () => {
  it('extracts and parses multiple XLSX attachments', async () => {
    const data = await workbookBytes();
    const attachments = await extractWorkbooks(email([data, data]));
    expect(attachments).toEqual([data, data]);
    const report = await parseWorkbook(attachments[0]!, fixtureAdapter);
    expect(report.intervals).toEqual([{
      direction: '+A', startMs: firstHour, originalTimestamp: 'fixture timestamp',
      originalKwh: '0,125', microKwh: 125_000,
    }]);
  });

  it('rejects missing attachments, oversize mail and invalid ZIPs', async () => {
    await expect(extractWorkbooks(Buffer.from('invalid email'))).rejects.toThrow('no XLSX');
    await expect(extractWorkbooks(Buffer.alloc(MAX_EMAIL_BYTES + 1))).rejects.toThrow('12 MiB');
    await expect(extractWorkbooks(email([Buffer.from('invalid')]))).rejects.toThrow('ZIP signature');
    await expect(parseWorkbook(Buffer.from('504b0304', 'hex'), fixtureAdapter)).rejects.toThrow('Invalid XLSX');
  });

  it('rejects spreadsheets outside the supported production layout', async () => {
    const data = await workbookBytes();
    await expect(parseWorkbook(data)).rejects.toThrow('Unrecognized');
    await expect(parseWorkbook(data, { ...fixtureAdapter, parse: () => undefined })).rejects.toThrow('Unrecognized');
  });
});
