import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { R2 } from '../src/r2/client.js';

afterEach(() => vi.restoreAllMocks());

it('lists through continuation tokens and conditionally downloads an email', async () => {
  const second = 'incoming/2026-11-02/second.eml';
  const first = 'incoming/2026-11-01/first.eml';
  const metadata = { Size: 3, ETag: '"fixture"', LastModified: new Date('2026-11-02') };
  // The AWS method also has callback overloads. The importer uses promises.
  const prototype: { send(command: ListObjectsV2Command | GetObjectCommand): Promise<unknown> } = S3Client.prototype;
  const send = vi.spyOn(prototype, 'send')
    .mockResolvedValueOnce({
      IsTruncated: true, NextContinuationToken: 'next',
      Contents: [{ ...metadata, Key: second }, { ...metadata, Key: 'incoming/2026-11-02/notes.txt' }],
    })
    .mockResolvedValueOnce({ Contents: [{ ...metadata, Key: first }] })
    .mockResolvedValueOnce({ ContentLength: 3, Body: Readable.from([Buffer.from('eml')]) });
  const r2 = new R2('bucket', 'https://example.test', 'key', 'secret');
  try {
    const items = await r2.list('2026-11-01');
    expect(items.map(({ key }) => key)).toEqual([first, second]);
    expect((send.mock.calls[0]![0] as ListObjectsV2Command).input).toMatchObject({
      Bucket: 'bucket', Prefix: 'incoming/', StartAfter: 'incoming/2026-11-01/',
    });
    expect((send.mock.calls[1]![0] as ListObjectsV2Command).input).toMatchObject({ ContinuationToken: 'next' });
    expect(await r2.download(items[0]!)).toEqual(Buffer.from('eml'));
    expect((send.mock.calls[2]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'bucket', Key: first, IfMatch: '"fixture"',
    });
  } finally {
    r2.close();
  }
});
