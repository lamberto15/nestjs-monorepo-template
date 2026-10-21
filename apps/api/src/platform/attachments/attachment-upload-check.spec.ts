import { InMemoryDisk, S3Disk, type StorageDisk } from '@nestjs/storage';
import { describe, expect, it } from 'vitest';
import type { AttachmentLimits } from './attachment-limits.js';
import { checkUploadedObject } from './attachment-upload-check.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const TEXT = Buffer.from('Minutes of the meeting\nAll agreed.\n');
const GARBAGE = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

/** A zip whose first local header names `entry` (a .docx has `word/…`). */
function zipWith(entry: string) {
  const header = Buffer.alloc(30);
  header.write('PK\x03\x04', 0, 'latin1');
  header.writeUInt16LE(entry.length, 26);
  return Buffer.concat([header, Buffer.from(entry, 'latin1')]);
}
const DOCX_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const limits: AttachmentLimits = {
  maxBytes: 1024 * 1024,
  maxMb: 1,
  types: [
    'image/png',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/zip',
    DOCX_TYPE,
  ],
};

/** The object as a client PUT it: the announced upload, and what the store holds. */
async function stored(
  disk: StorageDisk,
  body: Buffer,
  storedType: string,
  announced: { size?: number; contentType?: string } = {},
) {
  await disk.put('tenants/t/attachments/u', body, { contentType: storedType });
  return {
    key: 'tenants/t/attachments/u',
    size: announced.size ?? body.length,
    contentType: announced.contentType ?? storedType,
  };
}

/**
 * A stand-in for the S3 endpoint at the boundary of the S3 disk (`fetch`):
 * HEAD and ranged GET over a Map, in path style. Records what was asked.
 */
function fakeS3(objects: Map<string, { body: Buffer; type: string }>) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const range = new Headers(init?.headers).get('range');
    requests.push(range ? `${method} ${range}` : method);
    const key = decodeURIComponent(url.pathname).replace(/^\/bucket\//, '');
    const object = objects.get(key);
    if (!object) {
      return new Response('<Error><Code>NoSuchKey</Code></Error>', {
        status: 404,
      });
    }
    const common = {
      'content-type': object.type,
      etag: '"abc"',
      'last-modified': new Date(0).toUTCString(),
    };
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { ...common, 'content-length': String(object.body.length) },
      });
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
    if (!match) {
      return new Response(new Uint8Array(object.body), {
        status: 200,
        headers: common,
      });
    }
    const start = Number(match[1]);
    const end = Math.min(
      match[2] ? Number(match[2]) : object.body.length - 1,
      object.body.length - 1,
    );
    return new Response(new Uint8Array(object.body.subarray(start, end + 1)), {
      status: 206,
      headers: {
        ...common,
        'content-range': `bytes ${start}-${end}/${object.body.length}`,
      },
    });
  }) as typeof globalThis.fetch;
  const disk = new S3Disk({
    bucket: 'bucket',
    region: 'eu-west-1',
    endpoint: 'http://s3.test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    retry: false,
    fetch,
  });
  return { disk, requests };
}

describe('checkUploadedObject', () => {
  it.each([
    ['a PNG', PNG, 'image/png', 'image/png'],
    ['a PDF', PDF, 'application/pdf', 'application/pdf'],
    [
      'text, typed as the upload through the API types it',
      TEXT,
      'text/plain; charset=utf-8',
      'text/plain; charset=utf-8',
    ],
    [
      'HTML announced as text: it is text, served as text',
      HTML,
      'text/plain; charset=utf-8',
      'text/plain; charset=utf-8',
    ],
    [
      'a docx announced as a zip',
      zipWith('word/document.xml'),
      'application/zip',
      DOCX_TYPE,
    ],
    [
      'a docx announced as a docx',
      zipWith('word/document.xml'),
      DOCX_TYPE,
      DOCX_TYPE,
    ],
    ['a plain zip', zipWith('a.txt'), 'application/zip', 'application/zip'],
  ])('accepts %s', async (_name, body, announced, detected) => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, body, announced);
    expect(await checkUploadedObject(disk, expected, limits)).toEqual({
      ok: true,
      size: body.length,
      contentType: detected,
    });
  });

  it('asks the store for the size and type (HEAD), then the first 64 KiB (ranged GET), nothing more', async () => {
    const { disk, requests } = fakeS3(
      new Map([['tenants/t/attachments/u', { body: PNG, type: 'image/png' }]]),
    );
    const verdict = await checkUploadedObject(
      disk,
      {
        key: 'tenants/t/attachments/u',
        size: PNG.length,
        contentType: 'image/png',
      },
      limits,
    );
    expect(verdict).toEqual({
      ok: true,
      size: PNG.length,
      contentType: 'image/png',
    });
    expect(requests).toEqual(['HEAD', 'GET bytes=0-65535']);
  });

  it('reads only the first 64 KiB of a large object', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(300 * 1024, 0x61)]);
    const { disk, requests } = fakeS3(
      new Map([['k', { body: big, type: 'application/pdf' }]]),
    );
    const verdict = await checkUploadedObject(
      disk,
      { key: 'k', size: big.length, contentType: 'application/pdf' },
      limits,
    );
    expect(verdict.ok).toBe(true);
    expect(requests).toEqual(['HEAD', 'GET bytes=0-65535']);
  });

  it('keeps the upload, to try again, when the object is not there yet', async () => {
    const { disk, requests } = fakeS3(new Map());
    const verdict = await checkUploadedObject(
      disk,
      { key: 'k', size: 10, contentType: 'image/png' },
      limits,
    );
    expect(verdict).toMatchObject({ ok: false, keep: true });
    expect(
      !verdict.ok && (verdict.error.getResponse() as { code: string }).code,
    ).toBe('attachment_upload_incomplete');
    expect(requests).toEqual(['HEAD']);
  });

  it('refuses an object that is not the announced size (400, delete it)', async () => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, PNG, 'image/png', {
      size: PNG.length - 1,
    });
    const verdict = await checkUploadedObject(disk, expected, limits);
    expect(verdict).toMatchObject({ ok: false, keep: false });
    expect(!verdict.ok && verdict.error.getStatus()).toBe(400);
    expect(
      !verdict.ok && (verdict.error.getResponse() as { code: string }).code,
    ).toBe('attachment_upload_mismatch');
  });

  it('refuses an object stored with another Content-Type than the one signed (400)', async () => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, PNG, 'image/gif', {
      contentType: 'image/png',
    });
    const verdict = await checkUploadedObject(disk, expected, limits);
    expect(verdict).toMatchObject({ ok: false, keep: false });
    expect(!verdict.ok && verdict.error.getStatus()).toBe(400);
  });

  it('refuses bytes that are not the type announced: HTML as a PNG (415)', async () => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, HTML, 'image/png');
    const verdict = await checkUploadedObject(disk, expected, limits);
    expect(verdict).toMatchObject({ ok: false, keep: false });
    expect(!verdict.ok && verdict.error.getStatus()).toBe(415);
  });

  it('refuses a PNG announced as a PDF, and a zip announced as an image (415)', async () => {
    for (const [body, announced] of [
      [PNG, 'application/pdf'],
      [zipWith('a.txt'), 'image/png'],
    ] as const) {
      const disk = new InMemoryDisk();
      const verdict = await checkUploadedObject(
        disk,
        await stored(disk, body, announced),
        limits,
      );
      expect(!verdict.ok && verdict.error.getStatus()).toBe(415);
    }
  });

  it('refuses bytes no type is recognized from (415)', async () => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, GARBAGE, 'application/pdf');
    const verdict = await checkUploadedObject(disk, expected, limits);
    expect(!verdict.ok && verdict.error.getStatus()).toBe(415);
  });

  it('refuses a type that is no longer allowed (415)', async () => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, PDF, 'application/pdf');
    const verdict = await checkUploadedObject(disk, expected, {
      ...limits,
      types: ['image/png'],
    });
    expect(!verdict.ok && verdict.error.getStatus()).toBe(415);
  });

  it('refuses an object over the limit now in force (413)', async () => {
    const disk = new InMemoryDisk();
    const expected = await stored(disk, PNG, 'image/png');
    const verdict = await checkUploadedObject(disk, expected, {
      ...limits,
      maxBytes: PNG.length - 1,
    });
    expect(verdict).toMatchObject({ ok: false, keep: false });
    expect(!verdict.ok && verdict.error.getStatus()).toBe(413);
  });

  it('throws when the store cannot be asked, so nothing is decided', async () => {
    const disk = new S3Disk({
      bucket: 'bucket',
      region: 'eu-west-1',
      endpoint: 'http://s3.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
      retry: false,
      fetch: (async () =>
        new Response('<Error><Code>InternalError</Code></Error>', {
          status: 500,
        })) as unknown as typeof globalThis.fetch,
    });
    await expect(
      checkUploadedObject(
        disk,
        { key: 'k', size: 10, contentType: 'image/png' },
        limits,
      ),
    ).rejects.toThrow();
  });
});
