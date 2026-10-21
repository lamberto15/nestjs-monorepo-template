import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Database } from '../src/core/database/drizzle.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
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
});
