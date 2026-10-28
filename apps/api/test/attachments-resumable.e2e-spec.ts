import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import { AttachmentSweepJob } from '../src/platform/attachments/attachment-sweep.job.js';
import { attachmentUploads } from '../src/platform/attachments/attachments.tables.js';
import { bootApp, type TestApp } from './support.js';

vi.hoisted(() => {
  process.env.ATTACHMENT_MAX_MB = '1';
});

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n'),
  Buffer.alloc(100, 0x20),
  Buffer.from('\ntrailer << >>\n%%EOF\n'),
]);

describe('resumable uploads (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  async function setup() {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'Big', body: 'x' })
        .expect(201)
    ).body as { id: string };
    const base = `/v1/test-items/${note.id}/attachments`;
    const start = (body: object = {}) =>
      editor.agent.post(`${base}/sessions`).send({
        name: 'big.pdf',
        size: PDF.length,
        contentType: 'application/pdf',
        ...body,
      });
    const chunk = (uploadId: string, offset: number, bytes: Buffer) =>
      editor.agent
        .put(`${base}/sessions/${uploadId}?offset=${offset}`)
        .set('content-type', 'application/octet-stream')
        .send(bytes);
    return { editor, note, base, start, chunk };
  }

  it('resumes after a failure, reports progress, and attaches once complete', async () => {
    const { editor, base, start, chunk } = await setup();
    const session = (await start().expect(201)).body as {
      uploadId: string;
      received: number;
    };
    expect(session.received).toBe(0);
    const half = Math.floor(PDF.length / 2);
    expect(
      (await chunk(session.uploadId, 0, PDF.subarray(0, half)).expect(200)).body
        .received,
    ).toBe(half);
    // A retried chunk, or one at a wrong offset, stores nothing.
    const stale = await chunk(
      session.uploadId,
      0,
      PDF.subarray(0, half),
    ).expect(409);
    expect(stale.body.code).toBe('attachment_upload_offset_mismatch');
    // Not complete yet, and nothing is attached.
    const early = await editor.agent
      .post(`${base}/complete`)
      .send({ uploadId: session.uploadId })
      .expect(409);
    expect(early.body.code).toBe('attachment_upload_incomplete');
    expect((await editor.agent.get(base).expect(200)).body.items).toHaveLength(
      0,
    );
    const progress = await editor.agent
      .get(`${base}/sessions/${session.uploadId}`)
      .expect(200);
    expect(progress.body.received).toBe(half);
    await chunk(session.uploadId, half, PDF.subarray(half)).expect(200);
    const done = await editor.agent
      .post(`${base}/complete`)
      .send({ uploadId: session.uploadId })
      .expect(201);
    expect(done.body).toMatchObject({
      name: 'big.pdf',
      size: PDF.length,
      contentType: 'application/pdf',
    });
    // Completing twice makes one attachment.
    await editor.agent
      .post(`${base}/complete`)
      .send({ uploadId: session.uploadId })
      .expect(404);
    expect((await editor.agent.get(base).expect(200)).body.items).toHaveLength(
      1,
    );
  });

  it('refuses what an upload refuses, checks the bytes, and binds the session to its owner', async () => {
    const { editor, base, start, chunk } = await setup();
    await start({ size: 2 * 1024 * 1024 }).expect(413);
    await start({ contentType: 'application/x-msdownload' }).expect(415);
    // Not a PDF, whatever was declared: refused on completion, nothing attached.
    const text = Buffer.alloc(PDF.length, 0x41);
    const session = (await start().expect(201)).body as { uploadId: string };
    await chunk(session.uploadId, 0, text).expect(200);
    await editor.agent
      .post(`${base}/complete`)
      .send({ uploadId: session.uploadId })
      .expect(415);
    expect((await editor.agent.get(base).expect(200)).body.items).toHaveLength(
      0,
    );
    const mine = (await start().expect(201)).body as { uploadId: string };
    const stranger = await node.user(['editor']);
    await stranger.agent.get(`${base}/sessions/${mine.uploadId}`).expect(404);
    await chunk(mine.uploadId, 0, Buffer.alloc(PDF.length + 1)).expect(413);
  });

  it('cancels, and the sweep removes an expired session with its parts', async () => {
    const { editor, base, start, chunk } = await setup();
    const disk = node.app.get(StorageDisk);
    const parts = async () => {
      const keys: string[] = [];
      for await (const entry of disk.listAll({ prefix: 'tenants/' })) {
        if (entry.key.includes('.parts/')) keys.push(entry.key);
      }
      return keys;
    };
    const before = (await parts()).length;
    const cancelled = (await start().expect(201)).body as { uploadId: string };
    await chunk(cancelled.uploadId, 0, PDF.subarray(0, 10)).expect(200);
    expect((await parts()).length).toBe(before + 1);
    await editor.agent
      .delete(`${base}/sessions/${cancelled.uploadId}`)
      .expect(204);
    expect((await parts()).length).toBe(before);
    await editor.agent
      .get(`${base}/sessions/${cancelled.uploadId}`)
      .expect(404);

    const expired = (await start().expect(201)).body as { uploadId: string };
    await chunk(expired.uploadId, 0, PDF.subarray(0, 10)).expect(200);
    await node.db
      .update(attachmentUploads)
      .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(attachmentUploads.id, expired.uploadId));
    await chunk(expired.uploadId, 10, PDF.subarray(10, 20)).expect(410);
    await node.app.get(AttachmentSweepJob).run();
    expect((await parts()).length).toBe(before);
    const rows = await node.db
      .select()
      .from(attachmentUploads)
      .where(eq(attachmentUploads.id, expired.uploadId));
    expect(rows).toHaveLength(0);
  });
});
