import { randomUUID } from 'node:crypto';
import { StorageDisk } from '@nestjs/storage';
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { AttachmentSweepJob } from '../src/platform/attachments/attachment-sweep.job.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import { bootApp, connect, type TestApp } from './support.js';

// A small limit, so the test of it sends 1 MB, not 25 (read when AppModule loads).
vi.hoisted(() => {
  process.env.ATTACHMENT_MAX_MB = '1';
});

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n',
);
const TEXT = Buffer.from('Minutes of the meeting\nAll agreed.\n');

describe('attachments (e2e)', () => {
  let node: TestApp;
  let db: Database;

  beforeAll(async () => {
    node = await bootApp();
    db = node.db;
  });
  afterAll(async () => {
    await node.close();
  });

  /** An editor and a draft note they own. */
  async function noteOfEditor() {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'With files', body: 'x' })
        .expect(201)
    ).body as { id: string };
    return { editor, note };
  }

  it('stores what it recognizes, lists it, and serves it through a signed link', async () => {
    const { editor, note } = await noteOfEditor();
    const png = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', PNG, { filename: 'dot.png', contentType: 'image/png' })
      .expect(201);
    expect(png.body).toMatchObject({
      subject: 'TestItem',
      recordId: note.id,
      name: 'dot.png',
      size: PNG.length,
      contentType: 'image/png',
      uploadedBy: `user:${editor.id}`,
    });
    expect(png.body).not.toHaveProperty('key');
    await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', PDF, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    // Declared as nothing in particular: the bytes decide.
    const text = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', TEXT, {
        // A path is cut to its name; a name keeps its accents (UTF-8, not latin1).
        filename: '../../résumé minutes.txt',
        contentType: 'application/octet-stream',
      })
      .expect(201);
    expect(text.body.contentType).toBe('text/plain; charset=utf-8');
    expect(text.body.name).toBe('résumé minutes.txt');

    const list = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    expect(
      list.body.items.map(
        (item: { name: string; size: number; contentType: string }) => [
          item.name,
          item.size,
          item.contentType,
        ],
      ),
    ).toEqual([
      ['résumé minutes.txt', TEXT.length, 'text/plain; charset=utf-8'],
      ['report.pdf', PDF.length, 'application/pdf'],
      ['dot.png', PNG.length, 'image/png'],
    ]);
    const filtered = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments?contentType=application/pdf`)
      .expect(200);
    expect(
      filtered.body.items.map((item: { name: string }) => item.name),
    ).toEqual(['report.pdf']);

    const download = await editor.agent
      .get(`/v1/attachments/${png.body.id}/download`)
      .expect(302);
    const file = await node
      .http()
      .get(local(download.headers.location!))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toContain('dot.png');

    // Text is served as a plain-text download, never run: HTML can't script.
    const html = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'page.html',
        contentType: 'text/plain',
      })
      .expect(201);
    const htmlLink = await editor.agent
      .get(`/v1/attachments/${html.body.id}/download`)
      .expect(302);
    const served = await node
      .http()
      .get(local(htmlLink.headers.location!))
      .expect(200);
    expect(served.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(served.headers['content-disposition']).toMatch(/^attachment/);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    await editor.agent.delete(`/v1/attachments/${html.body.id}`).expect(204);

    // Audited, with what was attached.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, png.body.id));
    expect(entries.map((entry) => entry.action)).toEqual(['attachment.added']);
    expect(entries[0]!.actor).toBe(`user:${editor.id}`);
    expect(entries[0]!.details).toMatchObject({
      subject: 'TestItem',
      recordId: note.id,
      name: 'dot.png',
      size: PNG.length,
    });
  });

  it('refuses what is too large (413), not allowed or not as declared (415), and stores nothing', async () => {
    const { editor, note } = await noteOfEditor();
    const disk = node.app.get(StorageDisk);
    const filesBefore = await count(disk);

    const large = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', Buffer.alloc(1024 * 1024 + 1, 'a'), {
        filename: 'big.txt',
        contentType: 'text/plain',
      })
      .expect(413);
    expect(large.body.code).toBe('payload_too_large');

    const binary = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach(
        'file',
        Buffer.from([
          0, 1, 2, 3, 4, 5, 250, 251, 252, 0, 0, 0, 7, 8, 9, 10, 11,
        ]),
        {
          filename: 'app.exe',
          contentType: 'application/octet-stream',
        },
      )
      .expect(415);
    expect(binary.body.code).toBe('unsupported_media_type');

    // Text dressed up as an image.
    const mismatch = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'cat.png',
        contentType: 'image/png',
      })
      .expect(415);
    expect(mismatch.body.code).toBe('unsupported_media_type');

    await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .field('other', 'x')
      .expect(400);

    const list = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    expect(list.body.items).toEqual([]);
    expect(await count(disk)).toBe(filesBefore);
  });

  it('hides a note the caller may not read (404), refuses an upload without TestItem.update (403)', async () => {
    const { editor, note } = await noteOfEditor();
    const added = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', TEXT, { filename: 'a.txt', contentType: 'text/plain' })
      .expect(201);

    // Another editor reads only their own items.
    const stranger = await node.user(['editor']);
    await stranger.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(404);
    await stranger.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', TEXT, { filename: 'b.txt', contentType: 'text/plain' })
      .expect(404);
    await stranger.agent
      .get(`/v1/attachments/${added.body.id}/download`)
      .expect(404);
    await stranger.agent.delete(`/v1/attachments/${added.body.id}`).expect(404);

    // A viewer reads every note, changes none.
    const viewer = await node.user(['viewer']);
    const seen = await viewer.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    expect(seen.body.items).toHaveLength(1);
    await viewer.agent
      .get(`/v1/attachments/${added.body.id}/download`)
      .expect(302);
    await viewer.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', TEXT, { filename: 'c.txt', contentType: 'text/plain' })
      .expect(403);

    // A client reads only its own items.
    const client = await node.client();
    await node
      .http()
      .get(`/v1/test-items/${note.id}/attachments`)
      .set('Authorization', client.auth)
      .expect(404);
    await node
      .http()
      .get(`/v1/test-items/00000000-0000-7000-8000-000000000000/attachments`)
      .set('Authorization', client.auth)
      .expect(404);
  });

  it('is removed by its uploader or whoever may change the note, not by another reader', async () => {
    const { editor, note } = await noteOfEditor();
    const disk = node.app.get(StorageDisk);
    const mine = (
      await editor.agent
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', TEXT, {
          filename: 'mine.txt',
          contentType: 'text/plain',
        })
        .expect(201)
    ).body as { id: string };
    // The administrator attaches one to the editor's note.
    const theirs = (
      await node
        .admin()
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', PDF, {
          filename: 'theirs.pdf',
          contentType: 'application/pdf',
        })
        .expect(201)
    ).body as { id: string };
    const [stored] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, theirs.id));
    expect(await disk.exists(stored!.key)).toBe(true);

    const viewer = await node.user(['viewer']);
    const refused = await viewer.agent
      .delete(`/v1/attachments/${theirs.id}`)
      .expect(403);
    expect(refused.body.code).toBe('forbidden');

    // The editor may change the note: they remove the administrator's file.
    await editor.agent.delete(`/v1/attachments/${theirs.id}`).expect(204);
    expect(await disk.exists(stored!.key)).toBe(false);
    // The uploader removes their own.
    await editor.agent.delete(`/v1/attachments/${mine.id}`).expect(204);
    await editor.agent.delete(`/v1/attachments/${mine.id}`).expect(404);

    const left = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    expect(left.body.items).toEqual([]);
    const entries = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.targetId, [mine.id, theirs.id]));
    expect(
      entries
        .filter((entry) => entry.action === 'attachment.removed')
        .map((entry) => [entry.targetId, entry.actor]),
    ).toEqual(
      expect.arrayContaining([
        [theirs.id, `user:${editor.id}`],
        [mine.id, `user:${editor.id}`],
      ]),
    );
  });

  it("keeps a deleted note's files while it can come back; the sweep deletes them once it is purged", async () => {
    const { editor, note } = await noteOfEditor();
    const disk = node.app.get(StorageDisk);
    const added = (
      await editor.agent
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', PNG, { filename: 'dot.png', contentType: 'image/png' })
        .expect(201)
    ).body as { id: string };
    const [row] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, added.id));

    await editor.agent.delete(`/v1/test-items/${note.id}`).expect(204);
    // In the bin: hidden with the note.
    await editor.agent.get(`/v1/test-items/${note.id}/attachments`).expect(404);
    await editor.agent.get(`/v1/attachments/${added.id}/download`).expect(404);
    const sweep = node.app.get(AttachmentSweepJob);
    expect(await sweep.run()).toBe(0);
    expect(await disk.exists(row!.key)).toBe(true);

    await db
      .update(testItems)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(testItems.id, note.id));
    await node.app.get(SoftDeletePurgeJob).run();
    expect(await sweep.run()).toBe(1);
    expect(
      await db.select().from(attachments).where(eq(attachments.id, added.id)),
    ).toEqual([]);
    expect(await disk.exists(row!.key)).toBe(false);
  });

  it('the sweep leaves attachments of existing records, binned ones included, and removes those of a record deleted outright', async () => {
    const editor = await node.user(['editor']);
    const disk = node.app.get(StorageDisk);
    const attach = async () => {
      const item = (
        await node
          .writeItem(editor.agent, { title: 'With files', body: 'x' })
          .expect(201)
      ).body as { id: string };
      const added = (
        await editor.agent
          .post(`/v1/test-items/${item.id}/attachments`)
          .attach('file', PNG, {
            filename: 'dot.png',
            contentType: 'image/png',
          })
          .expect(201)
      ).body as { id: string };
      const [row] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, added.id));
      return { item, row: row! };
    };
    const kept = await attach();
    const binned = await attach();
    const gone = await attach();
    await editor.agent.delete(`/v1/test-items/${binned.item.id}`).expect(204);
    await db.delete(testItems).where(eq(testItems.id, gone.item.id));

    expect(await node.app.get(AttachmentSweepJob).run()).toBe(1);

    expect(await disk.exists(kept.row.key)).toBe(true);
    expect(await disk.exists(binned.row.key)).toBe(true);
    expect(await disk.exists(gone.row.key)).toBe(false);
    const left = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        inArray(attachments.id, [kept.row.id, binned.row.id, gone.row.id]),
      );
    expect(left).toHaveLength(2);
    expect(left.map((row) => row.id)).toEqual(
      expect.arrayContaining([kept.row.id, binned.row.id]),
    );
    const swept = (
      await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'attachments.swept'))
    ).filter((entry) => JSON.stringify(entry.details).includes(gone.row.id));
    expect(swept).toHaveLength(1);
  });

  it('the sweep returns 0 and writes no audit entry when nothing is orphaned', async () => {
    const { editor, note } = await noteOfEditor();
    await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', PNG, { filename: 'dot.png', contentType: 'image/png' })
      .expect(201);
    const before = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attachments.swept'));
    expect(await node.app.get(AttachmentSweepJob).run()).toBe(0);
    const after = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attachments.swept'));
    expect(after).toHaveLength(before.length);
  });

  it('answers 503 documents_unavailable for a PDF while GOTENBERG_URL is unset', async () => {
    const { editor, note } = await noteOfEditor();
    const refused = await editor.agent
      .post(`/v1/test-items/${note.id}/pdf`)
      .set('Idempotency-Key', crypto.randomUUID())
      .expect(503);
    expect(refused.body.code).toBe('documents_unavailable');
    expect(
      await db
        .select()
        .from(attachments)
        .where(eq(attachments.recordId, note.id)),
    ).toEqual([]);
  });

  it('offers no direct uploads on a disk that is not S3: the flag is off and both routes answer 503 (presigned_uploads_unavailable)', async () => {
    const features = (await node.admin().get('/v1/features').expect(200)).body;
    expect(features.presignedUploads).toBe(false);
    const { editor, note } = await noteOfEditor();
    const presign = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments/presign`)
      .send({ name: 'dot.png', size: PNG.length, contentType: 'image/png' })
      .expect(503);
    expect(presign.body.code).toBe('presigned_uploads_unavailable');
    const complete = await editor.agent
      .post(`/v1/test-items/${note.id}/attachments/complete`)
      .send({ uploadId: crypto.randomUUID() })
      .expect(503);
    expect(complete.body.code).toBe('presigned_uploads_unavailable');
    // Uploading through the API is what works here.
    await editor.agent
      .post(`/v1/test-items/${note.id}/attachments`)
      .attach('file', PNG, { filename: 'dot.png', contentType: 'image/png' })
      .expect(201);
  });

  it('publishes the limits it enforces in GET /v1/lists/{subject} (ATTACHMENT_MAX_MB=1 here)', async () => {
    const { body } = await node.admin().get('/v1/lists/TestItem').expect(200);
    expect(body.attachmentLimits).toEqual({
      maxBytes: 1024 * 1024,
      maxMb: 1,
      types: expect.arrayContaining([
        'image/png',
        'application/pdf',
        'text/plain',
      ]),
    });
  });

  it("tells the record's open pages when its attachments change (record.attachments.changed), ids only", async () => {
    const { editor, note } = await noteOfEditor();
    const token = (
      await node
        .http()
        .post('/v1/auth/token')
        .send({ email: editor.email, password: editor.password })
        .expect(200)
    ).body.accessToken as string;
    const socket = await connect(node, token);
    const heard: Record<string, unknown>[] = [];
    socket.on('record.attachments.changed', (data: Record<string, unknown>) =>
      heard.push(data),
    );
    try {
      // Not an image: an image also tells that its renditions are made
      // (action `processed`, attachments-images.e2e-spec.ts).
      const added = await editor.agent
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', TEXT, {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(201);
      await editor.agent.delete(`/v1/attachments/${added.body.id}`).expect(204);
      await vi.waitFor(() => expect(heard).toHaveLength(2), { timeout: 5000 });
      expect(heard).toEqual(
        ['added', 'removed'].map((action) => ({
          subject: 'TestItem',
          recordId: note.id,
          attachmentId: added.body.id,
          action,
        })),
      );
    } finally {
      socket.disconnect();
    }
  });

  it("lists a user's uploads in their data export (the rows, not the files)", async () => {
    const { editor, note } = await noteOfEditor();
    const added = (
      await editor.agent
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', PDF, {
          filename: 'report.pdf',
          contentType: 'application/pdf',
        })
        .expect(201)
    ).body as { id: string };
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
    const uploads = rows.filter((row) => row.kind === 'attachments');
    expect(uploads.map((row) => row.id)).toEqual([added.id]);
    expect(uploads[0]!.data).toMatchObject({
      name: 'report.pdf',
      contentType: 'application/pdf',
      recordId: note.id,
    });
    expect(uploads[0]!.data).not.toHaveProperty('key');
  });

  it('asks people to acknowledge a version of a document, reminds them, and records who confirmed', async () => {
    const { editor, note } = await noteOfEditor();
    const reader = await node.user(['viewer']);
    const other = await node.user(['viewer']);
    const outsider = await node.user(['editor']);
    const attached = (
      await editor.agent
        .post(`/v1/test-items/${note.id}/attachments`)
        .attach('file', PDF, {
          filename: 'policy.pdf',
          contentType: 'application/pdf',
        })
        .expect(201)
    ).body as { id: string };
    const base = `/v1/attachments/${attached.id}`;
    const soon = new Date(Date.now() + 3_600_000).toISOString();

    // Only whoever may change the record asks; recipients must be members who may read it.
    await reader.agent
      .post(`${base}/acknowledgment-requests`)
      .send({ recipients: [`user:${other.id}`] })
      .expect(403);
    await outsider.agent
      .post(`${base}/acknowledgment-requests`)
      .send({ recipients: [`user:${other.id}`] })
      .expect(404);
    await editor.agent
      .post(`${base}/acknowledgment-requests`)
      .send({ recipients: [`user:${randomUUID()}`] })
      .expect(400);
    await editor.agent
      .post(`${base}/acknowledgment-requests`)
      .send({
        recipients: [`user:${reader.id}`],
        dueAt: '2020-01-01T00:00:00Z',
      })
      .expect(400);
    const asked = await editor.agent
      .post(`${base}/acknowledgment-requests`)
      .send({
        recipients: [`user:${reader.id}`, `user:${other.id}`],
        dueAt: soon,
      })
      .expect(201);
    expect(asked.body).toHaveLength(2);
    expect(asked.body[0]).toMatchObject({
      attachmentId: attached.id,
      version: 1,
      acknowledgedAt: null,
      overdue: false,
    });
    // Asking again adds nobody.
    await editor.agent
      .post(`${base}/acknowledgment-requests`)
      .send({ recipients: [`user:${reader.id}`] })
      .expect(201);

    // The person asked sees it; nobody else can acknowledge.
    const mine = await reader.agent.get('/v1/acknowledgments').expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({
        version: 1,
        document: expect.objectContaining({ name: 'policy.pdf' }),
      }),
    ]);
    await outsider.agent.post(`${base}/acknowledge`).expect(404);
    await editor.agent.post(`${base}/acknowledge`).expect(404);

    // Acknowledging twice records it once.
    const first = await reader.agent.post(`${base}/acknowledge`).expect(200);
    expect(first.body.acknowledgedAt).toEqual(expect.any(String));
    const again = await reader.agent.post(`${base}/acknowledge`).expect(200);
    expect(again.body.acknowledgedAt).toBe(first.body.acknowledgedAt);
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'acknowledgment.acknowledged'));
    expect(audit.filter((e) => e.targetId === attached.id)).toHaveLength(1);
    expect(
      (await reader.agent.get('/v1/acknowledgments').expect(200)).body.items,
    ).toEqual([]);

    // The dashboard (for whoever may change the record only), and reminders to those still waiting, once a day.
    await reader.agent.get(`${base}/acknowledgments`).expect(403);
    const board = await editor.agent.get(`${base}/acknowledgments`).expect(200);
    expect(board.body).toMatchObject({
      version: 1,
      total: 2,
      acknowledged: 1,
      pending: 1,
      overdue: 0,
    });
    expect(
      await editor.agent
        .post(`${base}/acknowledgments/remind`)
        .send({})
        .expect(200),
    ).toMatchObject({ body: { reminded: 1, skipped: 0 } });
    expect(
      (
        await editor.agent
          .post(`${base}/acknowledgments/remind`)
          .send({})
          .expect(200)
      ).body,
    ).toEqual({ reminded: 0, skipped: 1 });
    const waiting = (
      await editor.agent.get(`${base}/acknowledgments`).expect(200)
    ).body.items.find(
      (i: { recipient: string }) => i.recipient === `user:${other.id}`,
    );
    expect(waiting.reminders).toBe(1);

    // An answer stays; an unanswered request can be withdrawn.
    const answered = board.body.items.find(
      (i: { acknowledgedAt: string | null }) => i.acknowledgedAt,
    );
    await editor.agent
      .delete(`${base}/acknowledgments/${answered.id}`)
      .expect(409);
    await editor.agent
      .delete(`${base}/acknowledgments/${waiting.id}`)
      .expect(204);
    await other.agent.post(`${base}/acknowledge`).expect(404);

    // A removed document takes its requests with it.
    await editor.agent.delete(base).expect(204);
    await editor.agent.get(`${base}/acknowledgments`).expect(404);
  });
});

/** How many files the disk holds. */
async function count(disk: StorageDisk) {
  let files = 0;
  for await (const _entry of disk.listAll()) files++;
  return files;
}
