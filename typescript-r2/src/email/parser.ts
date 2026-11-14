import { simpleParser } from 'mailparser';
import { ImportError } from '../utils/log.js';

export const MAX_EMAIL_BYTES = 12 * 1024 * 1024;
const MAX_XLSX_BYTES = 6 * 1024 * 1024;
const MAX_XLSX_ATTACHMENTS = 8;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function extractWorkbooks(raw: Buffer): Promise<Buffer[]> {
  if (!raw.length || raw.length > MAX_EMAIL_BYTES) throw new ImportError('Email is empty or exceeds 12 MiB');
  let mail;
  try {
    mail = await simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
  } catch {
    throw new ImportError('Malformed MIME email');
  }
  const attachments = mail.attachments.filter(({ filename, contentType }) =>
    /\.xlsx$/i.test(filename ?? '') || contentType === XLSX_MIME);
  if (attachments.length === 0) throw new ImportError('Email contains no XLSX attachments');
  if (attachments.length > MAX_XLSX_ATTACHMENTS) throw new ImportError('Email contains more than eight XLSX attachments');
  return attachments.map(({ content }) => {
    if (content.length > MAX_XLSX_BYTES || content.subarray(0, 4).toString('hex') !== '504b0304') {
      throw new ImportError('XLSX attachment exceeds 6 MiB or lacks a ZIP signature');
    }
    return content;
  });
}
