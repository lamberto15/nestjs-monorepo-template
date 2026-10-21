import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Database } from '../src/core/database/drizzle.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { AttachmentImagesQueue } from '../src/platform/attachments/attachment-images.queue.js';
import { AttachmentImagesService } from '../src/platform/attachments/attachment-images.service.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import { ImageProcessor } from '../src/platform/images/image-processor.js';
import { bootApp, type TestApp } from './support.js';

// Small pictures only (100 × 100), and originals kept as uploaded: read when AppModule loads.
vi.hoisted(() => {
  process.env.IMAGE_MAX_PIXELS = '10000';
  process.env.IMAGE_STRIP_ORIGINALS = 'off';
});

const picture = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 90, b: 200 },
    },
  })
    .withExif({ IFD0: { Make: 'ACME' } })
    .jpeg()
    .toBuffer();

describe('image attachments with IMAGE_MAX_PIXELS and IMAGE_STRIP_ORIGINALS=off (e2e)', () => {
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

  async function uploadPicture(bytes: Buffer, filename: string) {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'Limits', body: 'x' })
        .expect(201)
    ).body as { id: string };
    const added = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', bytes, { filename, contentType: 'image/jpeg' })
      .expect(201);
    const id = added.body.id as string;
    await vi.waitFor(
      async () => {
        expect((await rowOf(id)).renditionStatus).not.toBe('pending');
      },
      { timeout: 20_000, interval: 100 },
    );
    return { editor, id };
  }

  const rowOf = async (id: string) =>
    (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!;

  it('leaves a picture over the pixel limit as uploaded, without renditions', async () => {
    const big = await picture(200, 100); // 20 000 pixels, over 10 000
    const { editor, id } = await uploadPicture(big, 'big.jpg');

    const row = await rowOf(id);
    expect(row.renditionStatus).toBe('failed');
    expect(row.renditions).toEqual({});
    expect(Buffer.compare(await disk.getBuffer(row.key), big)).toBe(0);
    await editor.agent.get(`/v1/attachments/${id}/download`).expect(302);
    await editor.agent
      .get(`/v1/attachments/${id}/download?rendition=preview`)
      .expect(404);
  });

  it('keeps the original byte for byte with stripping off, and strips only the renditions', async () => {
    const small = await picture(80, 60);
    const { editor, id } = await uploadPicture(small, 'small.jpg');

    const row = await rowOf(id);
    expect(row.renditionStatus).toBe('ready');
    const stored = await disk.getBuffer(row.key);
    expect(Buffer.compare(stored, small)).toBe(0);
    expect(row.size).toBe(small.length);
    // Its EXIF is still there: switching stripping off is a decision to keep it.
    expect((await sharp(stored).metadata()).exif).toBeDefined();
    const thumb = await disk.getBuffer(row.renditions.thumb!.key);
    expect((await sharp(thumb).metadata()).exif).toBeUndefined();

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, id));
    const done = entries.find(
      (entry) => entry.action === 'attachment.processed',
    );
    expect(done?.details).toMatchObject({
      renditions: ['thumb', 'preview'],
      stripped: [],
    });
    await editor.agent
      .get(`/v1/attachments/${id}/download?rendition=thumb`)
      .expect(302);
  });

  it('keeps the files of the job that won when a second job on the same pending image loses', async () => {
    // The original stays where it is (stripping is off), so its key, and any
    // name made from it, would be the same for both jobs.
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'Two jobs', body: 'x' })
        .expect(201)
    ).body as { id: string };
    // No job queued by the upload: the test runs both by hand.
    const enqueue = vi
      .spyOn(node.app.get(AttachmentImagesQueue), 'enqueue')
      .mockResolvedValue(undefined);
    let id: string;
    try {
      const added = await editor.agent
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', await picture(80, 60), {
          filename: 'twice.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201);
      id = added.body.id as string;
    } finally {
      enqueue.mockRestore();
    }
    const pending = await rowOf(id);
    expect(pending.renditionStatus).toBe('pending');
    const job = { tenantId: pending.tenantId, attachmentId: id };

    // Job B has read the row as pending and converted the picture, and waits
    // before writing; job A then runs whole and commits.
    const processor = node.app.get(ImageProcessor);
    const convert = processor.process.bind(processor);
    let run = 0;
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const spy = vi
      .spyOn(processor, 'process')
      .mockImplementation(async (input) => {
        const mine = ++run;
        const result = await convert(input);
        if (mine === 1) {
          reached();
          await gate;
        }
        return result;
      });
    const images = node.app.get(AttachmentImagesService);
    try {
      const loser = images.process(job);
      await atGate;
      expect(await images.process(job)).toBe('ready');
      const won = await rowOf(id);
      expect(won.renditionStatus).toBe('ready');
      expect(won.renditions.thumb).toBeDefined();

      open();
      expect(await loser).toBe('skipped');
    } finally {
      open();
      spy.mockRestore();
    }

    // The row is still A's, and its files are still on the disk.
    const row = await rowOf(id);
    expect(row.renditionStatus).toBe('ready');
    for (const name of ['thumb', 'preview'] as const) {
      expect(await disk.exists(row.renditions[name]!.key)).toBe(true);
    }
    await editor.agent
      .get(`/v1/attachments/${id}/download?rendition=thumb`)
      .expect(302);
  });
});
