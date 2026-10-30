import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { StorageDisk } from '@nestjs/storage';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Database } from '../src/core/database/drizzle.js';
import { MetricsService } from '../src/core/metrics/metrics.service.js';
import { TenantQuotas } from '../src/core/tenancy/tenant-quotas.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { AttachmentImagesRetryJob } from '../src/platform/attachments/attachment-images-retry.job.js';
import { AttachmentImagesProcessor } from '../src/platform/attachments/attachment-images.processor.js';
import {
  ATTACHMENT_IMAGES,
  type AttachmentImagesJob,
} from '../src/platform/attachments/attachment-images.queue.js';
import { AttachmentImagesQueue } from '../src/platform/attachments/attachment-images.queue.js';
import {
  AttachmentImagesService,
  RETRY_MS,
} from '../src/platform/attachments/attachment-images.service.js';
import { attachmentLimits } from '../src/platform/attachments/attachment-limits.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import { AttachmentSweepJob } from '../src/platform/attachments/attachment-sweep.job.js';
import { STALLED_REASON } from '../src/platform/data-transfer/data-transfer.processor.js';
import {
  ImageProcessor,
  MAX_INPUT_BYTES,
} from '../src/platform/images/image-processor.js';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { bootApp, connect, type TestApp } from './support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** A camera's EXIF: maker, model and a GPS position (the orientation is set apart). */
const EXIF = {
  IFD0: { Make: 'ACME', Model: 'Cam 1' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 26/1 46/1' },
};

const solid = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  });

/** 400 × 200 on the sensor, Orientation 6: a portrait 200 × 400 once upright. */
const photo = () =>
  solid(400, 200)
    .withExif(EXIF)
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

/** A PNG signature and a header: recognized as an image, but not one the library can decode. */
const DAMAGED_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);

describe('image attachments (e2e)', () => {
  let node: TestApp;
  let db: Database;
  let disk: StorageDisk;

  beforeAll(async () => {
    node = await bootApp();
    db = node.db;
    disk = node.app.get(StorageDisk);
  });
  afterAll(async () => {
    await node.close();
  });

  async function noteOfEditor() {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'With pictures', body: 'x' })
        .expect(201)
    ).body as { id: string };
    return { editor, note };
  }

  const upload = (
    editor: Awaited<ReturnType<typeof noteOfEditor>>['editor'],
    noteId: string,
    file: Buffer,
    filename: string,
    contentType: string,
  ) =>
    editor.agent
      .post(`/v1/test-items/${noteId}/attachments`)
      .attach('file', file, { filename, contentType });

  const rowOf = async (id: string) =>
    (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!;

  /** Waits until the image is no longer pending: the job has run. */
  const processed = (id: string) =>
    vi.waitFor(
      async () => {
        expect((await rowOf(id)).renditionStatus).not.toBe('pending');
      },
      { timeout: 20_000, interval: 100 },
    );

  /** The bytes a signed download link serves. */
  const fetchFile = (url: string) =>
    node
      .http()
      .get(local(url))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);

  const metric = async (result: string) => {
    const { body } = await node.app.get(MetricsService).scrape();
    const line = body
      .split('\n')
      .find((l) =>
        l.startsWith(`attachment_images_processed_total{result="${result}"`),
      );
    return line ? Number(line.split(' ').pop()) : 0;
  };

  /** An upload whose job is never queued (the tests run it by hand, or a Redis that lost it leaves it so). */
  async function pendingImage(file?: Buffer) {
    const { editor, note } = await noteOfEditor();
    const queue = node.app.get(AttachmentImagesQueue);
    const enqueue = vi.spyOn(queue, 'enqueue').mockResolvedValue(undefined);
    let added;
    try {
      added = await upload(
        editor,
        note.id,
        file ?? (await photo()),
        'lost.jpg',
        'image/jpeg',
      ).expect(201);
    } finally {
      enqueue.mockRestore();
    }
    return { editor, id: added.body.id as string };
  }

  /** What the queue hands the worker for an attachment. */
  const jobOf = (attachmentId: string): AttachmentImagesJob => ({
    tenantId: node.tenantId,
    attachmentId,
  });

  it('makes a thumb and a preview of an upload, strips its metadata, and serves them', async () => {
    const { editor, note } = await noteOfEditor();
    const original = await photo();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const added = await upload(
      editor,
      note.id,
      original,
      'photo.jpg',
      'image/jpeg',
    ).expect(201);
    // Not yet: the job runs on a worker, never in the request.
    expect(added.body).toMatchObject({
      contentType: 'image/jpeg',
      size: original.length,
      scanStatus: 'clean',
      renditionStatus: 'pending',
      renditions: {},
    });
    const before = await rowOf(added.body.id);
    await processed(added.body.id);

    // The row: renditions recorded, the original replaced by a stripped copy.
    const row = await rowOf(added.body.id);
    expect(row.renditionStatus).toBe('ready');
    expect(row.key).not.toBe(before.key);
    expect(row.key.endsWith('.jpg')).toBe(true);
    const stripped = await disk.getBuffer(row.key);
    expect(row.size).toBe(stripped.length);
    const info = await sharp(stripped).metadata();
    expect(info).toMatchObject({ format: 'jpeg', width: 200, height: 400 });
    expect(info.exif).toBeUndefined();
    expect(info.orientation).toBeUndefined();
    expect(stripped.includes(Buffer.from('ACME'))).toBe(false);
    // The file it replaced is gone; the renditions are next to the new one.
    expect(await disk.exists(before.key)).toBe(false);
    const stem = row.key.slice(0, -'.jpg'.length);
    expect(row.renditions.thumb?.key).toBe(`${stem}.thumb.webp`);
    expect(row.renditions.preview?.key).toBe(`${stem}.preview.webp`);

    // What the API shows: shapes, never keys.
    const listed = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    const item = listed.body.items[0];
    expect(item).toMatchObject({
      id: added.body.id,
      size: stripped.length,
      renditionStatus: 'ready',
      renditions: {
        thumb: { width: 128, height: 256, contentType: 'image/webp' },
        preview: { width: 200, height: 400, contentType: 'image/webp' },
      },
    });
    expect(item.renditions.thumb.size).toBe(
      (await disk.stat(row.renditions.thumb!.key)).size,
    );
    expect(JSON.stringify(item)).not.toContain('tenants/');

    // The original downloads as the stripped file; a rendition inline.
    const full = await editor.agent
      .get(`/v1/attachments/${added.body.id}/download`)
      .expect(302);
    const fullFile = await fetchFile(full.headers.location!);
    expect(Buffer.compare(fullFile.body as Buffer, stripped)).toBe(0);
    expect(fullFile.headers['content-disposition']).toContain('attachment');

    for (const [name, width, height] of [
      ['thumb', 128, 256],
      ['preview', 200, 400],
    ] as const) {
      const link = await editor.agent
        .get(`/v1/attachments/${added.body.id}/download?rendition=${name}`)
        .expect(302);
      const file = await fetchFile(link.headers.location!);
      expect(file.headers['content-type']).toBe('image/webp');
      expect(file.headers['content-disposition']).toMatch(/^inline/);
      expect(file.headers['content-disposition']).toContain(
        `photo.${name}.webp`,
      );
      const image = await sharp(file.body as Buffer).metadata();
      expect(image).toMatchObject({ format: 'webp', width, height });
      expect(image.exif).toBeUndefined();
    }
    await editor.agent
      .get(`/v1/attachments/${added.body.id}/download?rendition=huge`)
      .expect(400);

    // Audited by the system job, with what was removed.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, added.body.id));
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'attachment.added',
      'attachment.processed',
    ]);
    const done = entries.find(
      (entry) => entry.action === 'attachment.processed',
    )!;
    expect(done.actor).toBe('system:attachment-images');
    expect(done.details).toMatchObject({
      name: 'photo.jpg',
      renditions: ['thumb', 'preview'],
      stripped: ['exif'],
      size: { from: original.length, to: stripped.length },
    });
    expect(await metric('ready')).toBeGreaterThan(0);
  });

  it('tells the record\'s open pages when an image is processed (action "processed")', async () => {
    const { editor, note } = await noteOfEditor();
    const token = (
      await node
        .http()
        .post('/v1/auth/token')
        .send({ email: editor.email, password: editor.password })
        .expect(200)
    ).body.accessToken as string;
    const socket = await connect(node, token);
    const heard: { action: string; attachmentId: string }[] = [];
    socket.on(
      'record.attachments.changed',
      (data: { action: string; attachmentId: string }) => heard.push(data),
    );
    try {
      const added = await upload(
        editor,
        note.id,
        await photo(),
        'live.jpg',
        'image/jpeg',
      ).expect(201);
      await vi.waitFor(
        () =>
          expect(heard.map((event) => event.action)).toEqual([
            'added',
            'processed',
          ]),
        { timeout: 20_000, interval: 100 },
      );
      expect(heard.every((event) => event.attachmentId === added.body.id)).toBe(
        true,
      );
    } finally {
      socket.disconnect();
    }
  });

  it('leaves an original without metadata byte for byte, and still makes its renditions', async () => {
    const { editor, note } = await noteOfEditor();
    const plain = await solid(300, 200).jpeg().toBuffer();
    const added = await upload(
      editor,
      note.id,
      plain,
      'plain.jpg',
      'image/jpeg',
    ).expect(201);
    const before = await rowOf(added.body.id);
    await processed(added.body.id);

    const row = await rowOf(added.body.id);
    expect(row.renditionStatus).toBe('ready');
    expect(row.key).toBe(before.key);
    expect(row.size).toBe(plain.length);
    expect(Buffer.compare(await disk.getBuffer(row.key), plain)).toBe(0);
    expect(row.renditions.thumb).toMatchObject({ width: 256, height: 171 });
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, added.body.id));
    const done = entries.find(
      (entry) => entry.action === 'attachment.processed',
    )!;
    expect(done.details).toMatchObject({ stripped: [] });
    expect(done.details).not.toHaveProperty('size');
  });

  it('makes the renditions of a GIF from its first frame', async () => {
    const { editor, note } = await noteOfEditor();
    const gif = await solid(500, 300).gif().toBuffer();
    const added = await upload(
      editor,
      note.id,
      gif,
      'anim.gif',
      'image/gif',
    ).expect(201);
    await processed(added.body.id);
    const row = await rowOf(added.body.id);
    expect(row.renditionStatus).toBe('ready');
    expect(row.renditions.thumb).toMatchObject({ width: 256, height: 154 });
    expect(Buffer.compare(await disk.getBuffer(row.key), gif)).toBe(0);
  });

  it('processes a replaced image too, so that an earlier version can be restored', async () => {
    const { editor, note } = await noteOfEditor();
    const added = await upload(
      editor,
      note.id,
      await photo(),
      'photo.jpg',
      'image/jpeg',
    ).expect(201);
    await processed(added.body.id);
    const etag = async () =>
      (await editor.agent.get(`/v1/attachments/${added.body.id}`).expect(200))
        .headers.etag as string;

    const replaced = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments/${added.body.id}/versions`)
      .set('If-Match', await etag())
      .attach('file', await solid(300, 200).png().toBuffer(), {
        filename: 'second.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect(replaced.body).toMatchObject({
      version: 2,
      renditionStatus: 'pending',
    });
    // Its own job, not the finished one of version 1.
    await processed(added.body.id);
    expect((await rowOf(added.body.id)).renditionStatus).toBe('ready');

    const restored = await editor.agent
      .post(`/v1/attachments/${added.body.id}/versions/1/restore`)
      .set('If-Match', await etag())
      .send({})
      .expect(200);
    expect(restored.body).toMatchObject({ version: 3 });
  });

  it('leaves an image it cannot process as uploaded, marks it failed, and does not try again', async () => {
    const { editor, note } = await noteOfEditor();
    const failedBefore = await metric('failed');
    const added = await upload(
      editor,
      note.id,
      DAMAGED_PNG,
      'broken.png',
      'image/png',
    ).expect(201);
    expect(added.body.renditionStatus).toBe('pending');
    await processed(added.body.id);

    const row = await rowOf(added.body.id);
    expect(row.renditionStatus).toBe('failed');
    expect(row.renditions).toEqual({});
    expect(Buffer.compare(await disk.getBuffer(row.key), DAMAGED_PNG)).toBe(0);
    // The original still downloads; there is no rendition to download.
    await editor.agent
      .get(`/v1/attachments/${added.body.id}/download`)
      .expect(302);
    const missing = await editor.agent
      .get(`/v1/attachments/${added.body.id}/download?rendition=thumb`)
      .expect(404);
    expect(missing.body.code).toBe('attachment_rendition_not_found');
    expect(await metric('failed')).toBeGreaterThan(failedBefore);
    // One attempt: the same bytes would fail again.
    const queue = node.app.get<Queue>(getQueueToken(ATTACHMENT_IMAGES));
    const job = await queue.getJob(added.body.id);
    expect(job?.attemptsMade).toBe(1);
    expect(await job?.getState()).toBe('completed');
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, added.body.id));
    expect(entries.map((entry) => entry.action)).toEqual(['attachment.added']);
  });

  it('does not process what is not an image', async () => {
    const { editor, note } = await noteOfEditor();
    const added = await upload(
      editor,
      note.id,
      Buffer.from('Minutes of the meeting\n'),
      'minutes.txt',
      'text/plain',
    ).expect(201);
    expect(added.body).toMatchObject({ renditionStatus: null, renditions: {} });
    const queue = node.app.get<Queue>(getQueueToken(ATTACHMENT_IMAGES));
    expect(await queue.getJob(added.body.id)).toBeUndefined();
    const missing = await editor.agent
      .get(`/v1/attachments/${added.body.id}/download?rendition=preview`)
      .expect(404);
    expect(missing.body.code).toBe('attachment_rendition_not_found');
  });

  it('removes the renditions with the attachment (and the stripped original)', async () => {
    const { editor, note } = await noteOfEditor();
    const added = await upload(
      editor,
      note.id,
      await photo(),
      'gone.jpg',
      'image/jpeg',
    ).expect(201);
    await processed(added.body.id);
    const row = await rowOf(added.body.id);
    const keys = [
      row.key,
      row.renditions.thumb!.key,
      row.renditions.preview!.key,
    ];
    for (const key of keys) expect(await disk.exists(key)).toBe(true);

    await editor.agent.delete(`/v1/attachments/${added.body.id}`).expect(204);
    for (const key of keys) expect(await disk.exists(key)).toBe(false);
  });

  it('deletes the renditions with the sweep, once the note is gone for good', async () => {
    const { editor, note } = await noteOfEditor();
    const added = await upload(
      editor,
      note.id,
      await photo(),
      'swept.jpg',
      'image/jpeg',
    ).expect(201);
    await processed(added.body.id);
    const row = await rowOf(added.body.id);
    const keys = [
      row.key,
      row.renditions.thumb!.key,
      row.renditions.preview!.key,
    ];

    await editor.agent.delete(`/v1/test-items/${note.id}`).expect(204);
    await db
      .update(testItems)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(testItems.id, note.id));
    await node.app.get(SoftDeletePurgeJob).run();
    expect(await node.app.get(AttachmentSweepJob).run()).toBeGreaterThanOrEqual(
      1,
    );
    for (const key of keys) expect(await disk.exists(key)).toBe(false);
  });

  it("keeps the renditions' keys out of a user's data export", async () => {
    const { editor, note } = await noteOfEditor();
    const added = await upload(
      editor,
      note.id,
      await photo(),
      'export.jpg',
      'image/jpeg',
    ).expect(201);
    await processed(added.body.id);

    const started = await editor.agent
      .post('/v1/account/export')
      .send({})
      .expect(202);
    let status;
    for (let tries = 0; tries < 100; tries++) {
      status = (
        await editor.agent
          .get(`/v1/data/transfers/${started.body.id}`)
          .expect(200)
      ).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const rows = (await node.http().get(local(status.result.url)).expect(200))
      .body as { kind: string; id: string; data: Record<string, unknown> }[];
    const upload1 = rows.find(
      (row) => row.kind === 'attachments' && row.id === added.body.id,
    )!;
    expect(upload1.data).toMatchObject({
      renditionStatus: 'ready',
      renditions: { thumb: { width: 128, height: 256 } },
    });
    expect(JSON.stringify(upload1.data)).not.toContain('tenants/');
    expect(upload1.data).not.toHaveProperty('key');
  });

  describe('a job that was lost, or processing switched off', () => {
    it('queues an image that is still pending five minutes on, not before', async () => {
      const { editor, id } = await pendingImage();
      const queue = node.app.get<Queue>(getQueueToken(ATTACHMENT_IMAGES));
      expect(await queue.getJob(id)).toBeUndefined();
      const retry = node.app.get(AttachmentImagesRetryJob);
      const retryJob = (at: Date) =>
        queue.getJob(`${id}-${Math.floor(at.getTime() / RETRY_MS)}`);

      // Just uploaded: its own job may still be on its way.
      const now = new Date();
      await retry.run(now);
      expect(await retryJob(now)).toBeUndefined();
      expect((await rowOf(id)).renditionStatus).toBe('pending');
      const early = await editor.agent
        .get(`/v1/attachments/${id}/download?rendition=thumb`)
        .expect(404);
      expect(early.body.detail).toContain('not made yet');

      const later = new Date(now.getTime() + RETRY_MS + 1000);
      expect(await retry.run(later)).toBeGreaterThanOrEqual(1);
      expect(await retryJob(later)).toBeDefined();
      await processed(id);
      expect((await rowOf(id)).renditionStatus).toBe('ready');
    });

    it('releases the pending images when processing is switched back off', async () => {
      const { id } = await pendingImage();
      const queue = node.app.get(AttachmentImagesQueue);
      const off = vi.spyOn(queue, 'enabled', 'get').mockReturnValue(false);
      try {
        // A queued job ends quietly: it is not a failure to try again.
        expect(
          await node.app
            .get(AttachmentImagesService)
            .process({ tenantId: node.tenantId, attachmentId: id }),
        ).toBe('skipped');
        expect((await rowOf(id)).renditionStatus).toBe('pending');

        expect(
          await node.app.get(AttachmentImagesRetryJob).run(),
        ).toBeGreaterThanOrEqual(1);
        expect((await rowOf(id)).renditionStatus).toBeNull();
      } finally {
        off.mockRestore();
      }
    });
  });

  describe('when processing fails', () => {
    const images = () => node.app.get(AttachmentImagesService);

    it('fails an image whose file is not on the disk (missing)', async () => {
      const { id } = await pendingImage();
      await disk.delete((await rowOf(id)).key);
      expect(await images().process(jobOf(id))).toBe('failed');
      expect((await rowOf(id)).renditionStatus).toBe('failed');
    });

    it('fails an image larger than a worker loads (size), without reading it', async () => {
      const { id } = await pendingImage();
      const before = await rowOf(id);
      await db
        .update(attachments)
        .set({ size: MAX_INPUT_BYTES + 1 })
        .where(eq(attachments.id, id));
      const read = vi.spyOn(disk, 'getBuffer');
      try {
        expect(await images().process(jobOf(id))).toBe('failed');
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
      const row = await rowOf(id);
      expect(row).toMatchObject({ renditionStatus: 'failed', key: before.key });
      expect(await disk.exists(before.key)).toBe(true);
    });

    it('throws on a disk failure, so the queue tries again, and leaves none of its files behind', async () => {
      const { id } = await pendingImage();
      const before = await rowOf(id);
      const errors = await metric('error');
      const put = disk.put.bind(disk);
      const keys: string[] = [];
      // The stripped original is written, then the disk fails on the thumb.
      const failing = vi
        .spyOn(disk, 'put')
        .mockImplementation(async (...args: Parameters<StorageDisk['put']>) => {
          keys.push(args[0]);
          if (keys.length === 2) throw new Error('The disk is away.');
          return put(...args);
        });
      try {
        await expect(images().process(jobOf(id))).rejects.toThrow(
          'The disk is away.',
        );
      } finally {
        failing.mockRestore();
      }
      expect(keys).toHaveLength(2);
      for (const key of keys) expect(await disk.exists(key)).toBe(false);
      expect(await rowOf(id)).toMatchObject({
        renditionStatus: 'pending',
        key: before.key,
        size: before.size,
        renditions: {},
      });
      expect(await disk.exists(before.key)).toBe(true);
      expect(await metric('error')).toBeGreaterThan(errors);
      // The next attempt finds it as it was.
      expect(await images().process(jobOf(id))).toBe('ready');
    });

    it('tells the record\'s open pages when an image fails too (action "processed")', async () => {
      const { editor, note } = await noteOfEditor();
      const token = (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: editor.email, password: editor.password })
          .expect(200)
      ).body.accessToken as string;
      const socket = await connect(node, token);
      const heard: { action: string; attachmentId: string }[] = [];
      socket.on(
        'record.attachments.changed',
        (data: { action: string; attachmentId: string }) => heard.push(data),
      );
      try {
        const added = await upload(
          editor,
          note.id,
          DAMAGED_PNG,
          'broken.png',
          'image/png',
        ).expect(201);
        await vi.waitFor(
          () =>
            expect(heard.map((event) => event.action)).toEqual([
              'added',
              'processed',
            ]),
          { timeout: 20_000, interval: 100 },
        );
        expect((await rowOf(added.body.id)).renditionStatus).toBe('failed');
      } finally {
        socket.disconnect();
      }
    });

    it('fails an image its worker died on twice (a stalled job), so that nothing queues it again', async () => {
      const { id } = await pendingImage();
      const host = node.app.get(AttachmentImagesProcessor);
      const job = { id, data: jobOf(id) } as Job<AttachmentImagesJob>;

      // Any other failure (retries spent on a disk error): the retry job's.
      await host.onFailed(job, new Error('The disk is away.'));
      expect((await rowOf(id)).renditionStatus).toBe('pending');

      // BullMQ's own failure of a job whose runs never returned.
      await host.onFailed(job, new Error(STALLED_REASON));
      expect((await rowOf(id)).renditionStatus).toBe('failed');
      const later = new Date(Date.now() + RETRY_MS + 1000);
      await node.app.get(AttachmentImagesRetryJob).run(later);
      const queue = node.app.get<Queue>(getQueueToken(ATTACHMENT_IMAGES));
      expect(
        await queue.getJob(`${id}-${Math.floor(later.getTime() / RETRY_MS)}`),
      ).toBeUndefined();
      // A job gone meanwhile: nothing to do, and no error.
      await host.onFailed(undefined, new Error(STALLED_REASON));
    });

    /** Has the processor return a stripped copy of `size` bytes, writes recorded. */
    async function withStrippedCopy<T>(size: number, run: () => Promise<T>) {
      const processor = node.app.get(ImageProcessor);
      const convert = processor.process.bind(processor);
      const process = vi
        .spyOn(processor, 'process')
        .mockImplementation(async (input) => ({
          ...(await convert(input)),
          stripped: { data: Buffer.alloc(size, 1), removed: ['exif'] },
        }));
      const put = vi.spyOn(disk, 'put');
      try {
        const result = await run();
        return { result, written: put.mock.calls.map(([key]) => key) };
      } finally {
        process.mockRestore();
        put.mockRestore();
      }
    }

    it('fails an image whose stripped copy would be larger than ATTACHMENT_MAX_MB (size)', async () => {
      const { id } = await pendingImage();
      const before = await rowOf(id);
      const { maxBytes } = attachmentLimits(node.app.get(ConfigService));
      const { result, written } = await withStrippedCopy(maxBytes + 1, () =>
        images().process(jobOf(id)),
      );
      expect(result).toBe('failed');
      expect(written).toEqual([]);
      expect(await rowOf(id)).toMatchObject({
        renditionStatus: 'failed',
        key: before.key,
        size: before.size,
      });
    });

    it("holds the tenant's storage quota for what a stripped copy adds", async () => {
      const quotas = node.app.get(TenantQuotas);
      const limit = quotas.limit.bind(quotas);
      // The tenant is full: an upload, or anything that grows, is refused.
      const full = () =>
        vi
          .spyOn(quotas, 'limit')
          .mockImplementation(async (tenantId, resource, tx) =>
            resource === 'storageBytes' ? 0 : limit(tenantId, resource, tx),
          );

      // A copy no larger than the original takes no room: it goes through.
      const { id: smaller } = await pendingImage();
      const original = await rowOf(smaller);
      let spy = full();
      try {
        const { result } = await withStrippedCopy(original.size, () =>
          images().process(jobOf(smaller)),
        );
        expect(result).toBe('ready');
      } finally {
        spy.mockRestore();
      }

      // A larger one needs room: failed, as uploaded, its files deleted.
      const { id } = await pendingImage();
      const before = await rowOf(id);
      spy = full();
      try {
        const { result, written } = await withStrippedCopy(
          before.size + 1000,
          () => images().process(jobOf(id)),
        );
        expect(result).toBe('failed');
        expect(written).toHaveLength(3);
        for (const key of written) expect(await disk.exists(key)).toBe(false);
      } finally {
        spy.mockRestore();
      }
      expect(await rowOf(id)).toMatchObject({
        renditionStatus: 'failed',
        key: before.key,
        size: before.size,
        renditions: {},
      });
      expect(await disk.exists(before.key)).toBe(true);
    });
  });
});
