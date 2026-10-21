import { getQueueToken } from '@nestjs/bullmq';
import { StorageDisk } from '@nestjs/storage';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { ATTACHMENT_IMAGES } from '../src/platform/attachments/attachment-images.queue.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: images are stored as uploaded.
vi.hoisted(() => {
  process.env.IMAGE_PROCESSING = 'off';
});

describe('image attachments with IMAGE_PROCESSING=off (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('stores an image as uploaded: no state, no job, no renditions', async () => {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'Off', body: 'x' })
        .expect(201)
    ).body as { id: string };
    const original = await sharp({
      create: {
        width: 60,
        height: 40,
        channels: 3,
        background: { r: 20, g: 90, b: 200 },
      },
    })
      .withExif({ IFD0: { Make: 'ACME' } })
      .jpeg()
      .toBuffer();

    const added = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', original, {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    expect(added.body).toMatchObject({ renditionStatus: null, renditions: {} });
    expect(
      await node.app
        .get<Queue>(getQueueToken(ATTACHMENT_IMAGES))
        .getJob(added.body.id),
    ).toBeUndefined();

    const [row] = await node.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, added.body.id));
    const stored = await node.app.get(StorageDisk).getBuffer(row!.key);
    expect(Buffer.compare(stored, original)).toBe(0);
    await editor.agent
      .get(`/v1/attachments/${added.body.id}/download?rendition=thumb`)
      .expect(404);
  });
});
