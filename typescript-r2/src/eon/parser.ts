import ExcelJS from 'exceljs';
import type { Workbook } from 'exceljs';
import { fromBuffer } from 'yauzl';
import type { ZipFile } from 'yauzl';
import { parseW1000 } from './w1000.js';
import type { Report } from './types.js';
import { ImportError } from '../utils/log.js';

const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 512;

export interface ReportAdapter {
  readonly validatedAgainstRealExport: boolean;
  parse(workbook: Workbook): Report | undefined;
}

export const eonAdapter: ReportAdapter = { validatedAgainstRealExport: true, parse: parseW1000 };

async function checkArchive(content: Buffer): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(content, { lazyEntries: true }, (error, file) => {
      if (error) reject(error);
      else resolve(file);
    });
  });

  try {
    if (zip.entryCount > MAX_ENTRIES) throw new Error('entry limit');
    await new Promise<void>((resolve, reject) => {
      let expanded = 0;
      const paths = new Set<string>();
      zip.on('error', reject);
      zip.on('end', () => {
        if (paths.has('[Content_Types].xml') && paths.has('xl/workbook.xml') &&
          !paths.has('xl/vbaProject.bin')) resolve();
        else reject(new Error('workbook parts'));
      });
      zip.on('entry', (entry) => {
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED_BYTES || paths.has(entry.fileName)) {
          reject(new Error('archive limits'));
          return;
        }
        paths.add(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? new Error('missing archive stream'));
            return;
          }
          stream.on('error', reject);
          stream.on('end', () => zip.readEntry());
          stream.resume();
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

export async function parseWorkbook(content: Buffer, adapter = eonAdapter): Promise<Report> {
  const workbook = new ExcelJS.Workbook();
  try {
    await checkArchive(content);
    await workbook.xlsx.load(new Uint8Array(content).buffer);
  } catch {
    throw new ImportError('Invalid XLSX workbook or ZIP safety limit exceeded');
  }
  const report = adapter.parse(workbook);
  if (!report?.intervals.length) throw new ImportError('Unrecognized or empty E.ON workbook. Inspect the original email in R2');
  return report;
}
