import { addAbortSignal, Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { MAX_EMAIL_BYTES } from '../email/parser.js';
import { ImportError, log } from '../utils/log.js';

export type EmailObject = { key: string; etag: string; receivedMs: number; size: number };

export class R2 {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, endpoint: string, accessKeyId: string, secretAccessKey: string) {
    this.client = new S3Client({
      region: 'auto', endpoint, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async list(since?: string): Promise<EmailObject[]> {
    const objects: EmailObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.retry('list', (signal) => this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: 'incoming/',
        StartAfter: token === undefined && since ? `incoming/${since}/` : undefined,
        ContinuationToken: token,
      }), { abortSignal: signal }));
      for (const item of page.Contents ?? []) {
        if (!item.Key || !/^incoming\/\d{4}-\d{2}-\d{2}\/[\w-]+\.eml$/i.test(item.Key)) continue;
        if (since && item.Key.slice(9, 19) < since) continue;
        if (!item.ETag || !item.LastModified || item.Size === undefined) {
          throw new ImportError('R2 listing returned incomplete email object metadata');
        }
        objects.push({ key: item.Key, etag: item.ETag, receivedMs: item.LastModified.getTime(), size: item.Size });
      }
      const next = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!next || next === token)) throw new ImportError('R2 pagination did not advance');
      token = next;
    } while (token);
    return objects.sort((a, b) => a.receivedMs - b.receivedMs || a.key.localeCompare(b.key));
  }

  async download(object: EmailObject): Promise<Buffer> {
    if (object.size === 0 || object.size > MAX_EMAIL_BYTES) {
      throw new ImportError('R2 email is empty or exceeds 12 MiB');
    }
    return this.retry('download', async (signal) => {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: object.key, IfMatch: object.etag,
      }), { abortSignal: signal });
      const body = response.Body;
      if (!(body instanceof Readable) || response.ContentLength !== object.size) {
        if (body instanceof Readable) body.destroy();
        throw new ImportError('R2 email has a missing body or unexpected size');
      }
      addAbortSignal(signal, body);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > MAX_EMAIL_BYTES || size > object.size) throw new ImportError('R2 email stream exceeded its expected size');
        chunks.push(chunk);
      }
      if (size !== object.size) throw new Error('incomplete email stream');
      return Buffer.concat(chunks, size);
    });
  }

  close(): void {
    this.client.destroy();
  }

  private async retry<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(AbortSignal.timeout(30_000));
      } catch (error) {
        if (error instanceof ImportError) throw error;
        const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
        const retryable = status === undefined || status >= 500 || [408, 429].includes(status);
        if (!retryable || attempt >= 3) {
          throw new ImportError(`R2 ${operation} failed${status === undefined ? '' : ` with HTTP ${status}`}`);
        }
        log('retry', { service: 'r2', operation, attempt });
        await new Promise((resolve) => setTimeout(resolve, attempt * 500 + Math.random() * 250));
      }
    }
  }
}
