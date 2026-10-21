import { randomUUID } from 'node:crypto';
import { InMemoryDisk, STORAGE_MODULE_OPTIONS } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Test } from 'supertest';
import { auditLog } from '../src/iam/iam.tables.js';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { AttachmentSweepJob } from '../src/platform/attachments/attachment-sweep.job.js';
import { MAX_PENDING_UPLOADS } from '../src/platform/attachments/attachment-uploads.service.js';
import { ANONYMIZED_UPLOADER } from '../src/platform/attachments/attachments.service.js';
import {
  attachments,
  attachmentUploads,
} from '../src/platform/attachments/attachments.tables.js';
import { EICAR } from '../src/platform/attachments/malware-scanner.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads. MinIO is not available to the suite, so the S3
// driver is the configuration (the routes offer themselves, GET /v1/features
// says so) over an in-memory disk with app-served signed URLs, which does what
// S3 does with a presigned PUT (the signature, expiry, Content-Type and
// Content-Length are checked, the body streams onto the disk) and answers the
// HEAD and the ranged GET the completion reads. What the S3 disk itself signs
// and reads is unit-tested (attachment-types.spec.ts, attachment-upload-check.spec.ts).
vi.hoisted(() => {
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_BUCKET = 'test-bucket';
  process.env.ATTACHMENT_MAX_MB = '1';
  // Every attachment waits for its scan, which the in-memory scanner decides.
  process.env.MALWARE_SCANNER = 'memory';
});

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

const TEXT = Buffer.from('Minutes of the meeting\nAll agreed.\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

type Presigned = {
  uploadId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
};

describe('direct uploads to the object store (e2e, STORAGE_DRIVER=s3)', () => {
  let node: TestApp;
  let png: Buffer;
  const disk = new InMemoryDisk({
    signedUrls: {
      baseUrl: 'http://127.0.0.1/files',
      keys: ['presign-e2e-signing-key-32-characters-long'],
    },
  });

  beforeAll(async () => {
    png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 200, g: 20, b: 20 },
      },
    })
      .png()
      .toBuffer();
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(STORAGE_MODULE_OPTIONS).useValue({
        default: 'files',
        disks: { files: disk },
      }),
    );
  });
  afterAll(async () => {
    await node.close();
  });

  async function noteOfEditor() {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'With files', body: 'x' })
        .expect(201)
    ).body as { id: string };
    return { editor, note };
  }
  type Editor = Awaited<ReturnType<typeof noteOfEditor>>['editor'];

  const presign = (
    editor: Editor,
    noteId: string,
    body: { name?: string; size?: number; contentType?: string },
  ) =>
    editor.agent
      .post(`/v1/test-items/${noteId}/attachments/presign`)
      .send(body);
  const complete = (editor: Editor, noteId: string, uploadId: string) =>
    editor.agent
      .post(`/v1/test-items/${noteId}/attachments/complete`)
      .send({ uploadId });
  /** The PUT a client makes to the URL: the signed headers, as they are. */
  const put = (presigned: Presigned, body: Buffer): Test => {
    const request = node.http().put(local(presigned.url));
    for (const [name, value] of Object.entries(presigned.headers)) {
      request.set(name, value);
    }
    return request.send(body);
  };
  /** Announces `file` and PUTs it: the upload, ready to complete. */
  async function announce(
    editor: Editor,
    noteId: string,
    file: Buffer,
    contentType: string,
    name = 'file',
  ) {
    const presigned = (
      await presign(editor, noteId, {
        name,
        size: file.length,
        contentType,
      }).expect(201)
    ).body as Presigned;
    const type = presigned.headers['content-type']!;
    if (type.startsWith('text/')) {
      // The stand-in's PUT route is the app's, and the app parses text/plain
      // bodies in front of it (http-setup.ts, for SNS): not what a bucket does.
      // The object is put where the signed URL points, as the bucket would.
      await disk.put((await uploadRow(presigned.uploadId))!.key, file, {
        contentType: type,
      });
    } else {
      await put(presigned, file).expect(200);
    }
    return presigned;
  }
  const uploadRow = async (uploadId: string) =>
    (
      await node.db
        .select()
        .from(attachmentUploads)
        .where(eq(attachmentUploads.id, uploadId))
    )[0];

  /** The attachment-sized objects on the disk that were not there in `before` (renditions have their own names). */
  const newObjects = (before: ReadonlySet<string>) =>
    disk
      .keys()
      .filter(
        (key) =>
          !before.has(key) &&
          new RegExp(
            `^tenants/${node.tenantId}/attachments/[0-9a-f-]{36}$`,
          ).test(key),
      );

  it('is offered: GET /v1/features says so', async () => {
    const features = (await node.admin().get('/v1/features').expect(200)).body;
    expect(features.presignedUploads).toBe(true);
  });

  it('presigns a PUT bound to a key the server chose, then attaches what was PUT, through the same path as an upload', async () => {
    const { editor, note } = await noteOfEditor();
    const presigned = (
      await presign(editor, note.id, {
        name: '../../photo.png',
        size: png.length,
        contentType: 'image/png',
      }).expect(201)
    ).body as Presigned;

    expect(presigned).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    });
    expect(presigned.url).toContain('/files?');
    expect(presigned).not.toHaveProperty('key');
    const minutes =
      (new Date(presigned.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);

    // The server's key, under the tenant's prefix, and the record of what was signed.
    const pending = (await uploadRow(presigned.uploadId))!;
    expect(pending.key).toMatch(
      new RegExp(`^tenants/${node.tenantId}/attachments/[0-9a-f-]{36}$`),
    );
    expect(pending).toMatchObject({
      tenantId: node.tenantId,
      subject: 'TestItem',
      recordId: note.id,
      size: png.length,
      contentType: 'image/png',
      uploadedBy: `user:${editor.id}`,
    });
    // Nothing is attached before the file is there and the upload completed.
    expect(
      (
        await editor.agent
          .get(`/v1/test-items/${note.id}/attachments`)
          .expect(200)
      ).body.items,
    ).toEqual([]);

    await put(presigned, png).expect(200);
    expect(disk.keys()).toContain(pending.key);

    const completed = await complete(
      editor,
      note.id,
      presigned.uploadId,
    ).expect(201);
    expect(completed.body).toMatchObject({
      subject: 'TestItem',
      recordId: note.id,
      name: 'photo.png',
      size: png.length,
      contentType: 'image/png',
      uploadedBy: `user:${editor.id}`,
      locked: false,
      // The malware scan and the renditions apply, as to any upload.
      scanStatus: 'pending',
      renditionStatus: 'pending',
    });
    expect(completed.body).not.toHaveProperty('key');

    // The attachment is a copy of the object that was PUT, on a key of the
    // server's own in this tenant (the signed URL reaches only the first).
    const [row] = await node.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, completed.body.id));
    expect(row).toMatchObject({ tenantId: node.tenantId });
    expect(row!.key).toMatch(
      new RegExp(`^tenants/${node.tenantId}/attachments/[0-9a-f-]{36}$`),
    );
    expect(row!.key).not.toBe(pending.key);
    expect(disk.keys()).toContain(row!.key);
    expect(disk.keys()).not.toContain(pending.key);
    // The announcement is completed: it can't be again, and is not pending.
    expect(await uploadRow(presigned.uploadId)).toMatchObject({
      key: pending.key,
      completedAt: expect.any(Date),
    });
    // Audited like any upload, by the uploader, in the tenant.
    const entries = await node.auditEntries({
      action: 'attachment.added',
      targetId: completed.body.id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: `user:${editor.id}`,
      tenantId: node.tenantId,
    });
    expect(entries[0]!.details).toMatchObject({
      subject: 'TestItem',
      recordId: note.id,
      name: 'photo.png',
      size: png.length,
      contentType: 'image/png',
    });

    // The scan, then the renditions: the jobs of the upload through the API.
    await vi.waitFor(
      async () => {
        const [current] = await node.db
          .select()
          .from(attachments)
          .where(eq(attachments.id, completed.body.id));
        expect(current).toMatchObject({
          scanStatus: 'clean',
          renditionStatus: 'ready',
        });
      },
      { timeout: 20_000, interval: 250 },
    );
    const listed = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].renditions.thumb).toBeDefined();

    // And it downloads through a signed link like any other.
    const link = await editor.agent
      .get(`/v1/attachments/${completed.body.id}/download`)
      .expect(302);
    const file = await node
      .http()
      .get(local(link.headers.location!))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(file.body as Buffer, png)).toBe(0);
  });

  it('types the object from its bytes, not from the declaration: text announced as text/markdown is stored as text', async () => {
    const { editor, note } = await noteOfEditor();
    const presigned = await announce(
      editor,
      note.id,
      TEXT,
      'text/markdown',
      'minutes.md',
    );
    // The URL is signed for the type we keep, not the client's spelling.
    expect(presigned.headers['content-type']).toBe('text/plain; charset=utf-8');
    const completed = await complete(
      editor,
      note.id,
      presigned.uploadId,
    ).expect(201);
    expect(completed.body.contentType).toBe('text/plain; charset=utf-8');
    // Text is no image: nothing to render.
    expect(completed.body.renditionStatus).toBeNull();
  });

  it('scans a direct upload: an infected file is deleted, row and object, and the uploader told', async () => {
    const { editor, note } = await noteOfEditor();
    const infected = Buffer.from(`${EICAR}\n`);
    const presigned = await announce(
      editor,
      note.id,
      infected,
      'text/plain',
      'eicar.txt',
    );
    const before = new Set(disk.keys());
    const completed = await complete(
      editor,
      note.id,
      presigned.uploadId,
    ).expect(201);
    expect(completed.body.scanStatus).toBe('pending');

    await vi.waitFor(
      async () => {
        const rows = await node.db
          .select()
          .from(attachments)
          .where(eq(attachments.id, completed.body.id));
        expect(rows).toHaveLength(0);
      },
      { timeout: 15_000, interval: 250 },
    );
    // Neither the file that was PUT nor the copy that was scanned is left.
    expect(disk.keys()).not.toContain(
      (await uploadRow(presigned.uploadId))!.key,
    );
    expect(newObjects(before)).toEqual([]);
    const rejected = await node.auditEntries({
      action: 'attachment.rejected',
      targetId: completed.body.id,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.actor).toBe('system:attachment-scan');
  });

  describe('announcing (presign)', () => {
    it('refuses what the upload through the API refuses: too large (413), a type not allowed or not declared (415)', async () => {
      const { editor, note } = await noteOfEditor();
      const tooLarge = await presign(editor, note.id, {
        name: 'big.png',
        size: 1024 * 1024 + 1,
        contentType: 'image/png',
      }).expect(413);
      expect(tooLarge.body.code).toBe('payload_too_large');
      for (const contentType of [
        'application/x-msdownload',
        'text/html', // text, so text/plain: allowed (stored and served as text)
        'application/octet-stream',
        'image/png\r\nx-amz-acl: public-read',
      ]) {
        const answer = await presign(editor, note.id, {
          name: 'x',
          size: 10,
          contentType,
        });
        if (contentType === 'text/html') {
          expect(answer.status).toBe(201);
          expect(answer.body.headers['content-type']).toBe(
            'text/plain; charset=utf-8',
          );
        } else {
          expect(answer.status, contentType).toBe(415);
          expect(answer.body.code).toBe('unsupported_media_type');
        }
      }
    });

    it('validates the body (400)', async () => {
      const { editor, note } = await noteOfEditor();
      for (const body of [
        {},
        { name: 'a.png', size: 0, contentType: 'image/png' },
        { name: 'a.png', size: 1.5, contentType: 'image/png' },
        { name: '', size: 10, contentType: 'image/png' },
        { name: 'a.png', size: 10 },
      ]) {
        const answer = await presign(editor, note.id, body).expect(400);
        expect(answer.body.code).toBe('validation_failed');
      }
    });

    it('needs the right to attach files to the record, as the upload does: 404, or 403 for a reader', async () => {
      const { editor, note } = await noteOfEditor();
      const viewer = await node.user(['viewer']);
      const body = {
        name: 'a.png',
        size: png.length,
        contentType: 'image/png',
      };
      await presign(editor, randomUUID(), body).expect(404);
      await presign(editor, 'not-a-uuid', body).expect(400);
      await node
        .http()
        .post(`/v1/test-items/${note.id}/attachments/presign`)
        .send(body)
        .expect(401);
      // A stranger sees no draft note of the editor's.
      const refused = await presign(viewer, note.id, body);
      expect([403, 404]).toContain(refused.status);
      expect(await node.db.select().from(attachmentUploads)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uploadedBy: `user:${viewer.id}` }),
        ]),
      );
    });

    it('stops at MAX_PENDING_UPLOADS announced and not completed (429)', async () => {
      const { editor, note } = await noteOfEditor();
      const body = {
        name: 'a.png',
        size: png.length,
        contentType: 'image/png',
      };
      await node.db.insert(attachmentUploads).values(
        Array.from({ length: MAX_PENDING_UPLOADS }, () => ({
          tenantId: node.tenantId,
          subject: 'TestItem',
          recordId: note.id,
          key: `tenants/${node.tenantId}/attachments/${randomUUID()}`,
          name: 'later.png',
          size: 1,
          contentType: 'image/png',
          uploadedBy: `user:${editor.id}`,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );
      const refused = await presign(editor, note.id, body).expect(429);
      expect(refused.body.code).toBe('attachment_uploads_pending');
      // Someone else is not held up by it.
      const other = await noteOfEditor();
      await presign(other.editor, other.note.id, body).expect(201);
    });

    it('counts only what can still be completed: an expired link or a completed upload frees its place (429 otherwise)', async () => {
      const { editor, note } = await noteOfEditor();
      const body = {
        name: 'a.png',
        size: png.length,
        contentType: 'image/png',
      };
      const row = (expiresAt: Date, completedAt: Date | null = null) => ({
        tenantId: node.tenantId,
        subject: 'TestItem',
        recordId: note.id,
        key: `tenants/${node.tenantId}/attachments/${randomUUID()}`,
        name: 'later.png',
        size: 1,
        contentType: 'image/png',
        uploadedBy: `user:${editor.id}`,
        expiresAt,
        completedAt,
      });
      const many = <T>(make: () => T) =>
        Array.from({ length: MAX_PENDING_UPLOADS }, make);
      await node.db.insert(attachmentUploads).values([
        // Links that expired (a PUT that failed, a closed tab), the sweep not yet run.
        ...many(() => row(new Date(Date.now() - 60_000))),
        // Uploads that became attachments, their rows kept until the sweep.
        ...many(() => row(new Date(Date.now() + 60_000), new Date())),
        // And one place short of the limit that does count.
        ...Array.from({ length: MAX_PENDING_UPLOADS - 1 }, () =>
          row(new Date(Date.now() + 60_000)),
        ),
      ]);
      await presign(editor, note.id, body).expect(201);
      const refused = await presign(editor, note.id, body).expect(429);
      expect(refused.body.code).toBe('attachment_uploads_pending');
    });

    it("refuses what does not fit the tenant's storage quota, as the upload does (422)", async () => {
      const other = await node.otherTenant();
      const item = (
        await node
          .writeItem(other.admin, { title: 'files', body: 'x' })
          .expect(201)
      ).body as { id: string };
      await node
        .admin()
        .put(`/v1/tenants/${other.id}/quotas`)
        .send({ maxStorageBytes: png.length })
        .expect(200);
      const body = {
        name: 'a.png',
        size: png.length,
        contentType: 'image/png',
      };
      const announce = () =>
        other.admin
          .post(`/v1/test-items/${item.id}/attachments/presign`)
          .send(body);
      const first = (await announce().expect(201)).body as Presigned;
      await put(first, png).expect(200);
      await other.admin
        .post(`/v1/test-items/${item.id}/attachments/complete`)
        .send({ uploadId: first.uploadId })
        .expect(201);
      // Full: refused before the client sends a byte.
      const refused = await announce().expect(422);
      expect(refused.body).toMatchObject({
        code: 'quota_exceeded',
        quota: { resource: 'storageBytes' },
      });
      await node
        .admin()
        .put(`/v1/tenants/${other.id}/quotas`)
        .send({ maxStorageBytes: null })
        .expect(200);
    });
  });

  describe('the PUT (what the store enforces)', () => {
    it('takes exactly the signed size, type and no later than the expiry (403)', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = (
        await presign(editor, note.id, {
          name: 'a.png',
          size: png.length,
          contentType: 'image/png',
        }).expect(201)
      ).body as Presigned;
      await put(presigned, Buffer.concat([png, png])).expect(403);
      await put(
        { ...presigned, headers: { 'content-type': 'image/gif' } },
        png,
      ).expect(403);
      // Tampered: another key under the same signature.
      const url = new URL(presigned.url);
      url.searchParams.set('key', `tenants/${randomUUID()}/attachments/x`);
      await put({ ...presigned, url: url.toString() }, png).expect(403);
      expect(disk.keys()).not.toContain(
        (await uploadRow(presigned.uploadId))!.key,
      );
    });
  });

  describe('completing', () => {
    it('answers 409 until the file is there, and keeps the upload: PUT, then complete', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = (
        await presign(editor, note.id, {
          name: 'late.png',
          size: png.length,
          contentType: 'image/png',
        }).expect(201)
      ).body as Presigned;
      const early = await complete(editor, note.id, presigned.uploadId).expect(
        409,
      );
      expect(early.body.code).toBe('attachment_upload_incomplete');
      expect(await uploadRow(presigned.uploadId)).toBeDefined();
      // Not held by the failed attempt.
      await put(presigned, png).expect(200);
      await complete(editor, note.id, presigned.uploadId).expect(201);
    });

    it('deletes an object whose bytes are not the type announced (415): row and object', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(
        editor,
        note.id,
        HTML,
        'image/png',
        'logo.png',
      );
      const key = (await uploadRow(presigned.uploadId))!.key;
      expect(disk.keys()).toContain(key);
      const before = new Set(disk.keys());
      const refused = await complete(
        editor,
        note.id,
        presigned.uploadId,
      ).expect(415);
      expect(refused.body.code).toBe('unsupported_media_type');
      // The object that was PUT and the copy that was checked are both gone.
      expect(disk.keys()).not.toContain(key);
      expect(newObjects(before)).toEqual([]);
      expect(await uploadRow(presigned.uploadId)).toBeUndefined();
      expect(
        (
          await editor.agent
            .get(`/v1/test-items/${note.id}/attachments`)
            .expect(200)
        ).body.items,
      ).toEqual([]);
      // Nothing left to complete.
      await complete(editor, note.id, presigned.uploadId).expect(404);
    });

    it('deletes a type that is allowed but not the declared one (a PDF announced as an image)', async () => {
      const { editor, note } = await noteOfEditor();
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');
      const presigned = await announce(editor, note.id, pdf, 'image/png');
      const key = (await uploadRow(presigned.uploadId))!.key;
      const before = new Set(disk.keys());
      await complete(editor, note.id, presigned.uploadId).expect(415);
      expect(disk.keys()).not.toContain(key);
      expect(newObjects(before)).toEqual([]);
    });

    it('keeps what it checked: a PUT to the same URL after the completion changes neither the attachment nor the upload, and the sweep clears it', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      const staging = (await uploadRow(presigned.uploadId))!.key;
      const completed = await complete(
        editor,
        note.id,
        presigned.uploadId,
      ).expect(201);
      const [attachment] = await node.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, completed.body.id));

      // The link works for ten minutes: the same size and type, other bytes.
      const other = Buffer.alloc(png.length, 0x41);
      other.write('<html><script>alert(1)</script></html>');
      await put(presigned, other).expect(200);
      expect(Buffer.compare(await disk.getBuffer(staging), other)).toBe(0);

      // The attachment is the file that was checked, not what was PUT since.
      expect(attachment!.key).not.toBe(staging);
      expect(Buffer.compare(await disk.getBuffer(attachment!.key), png)).toBe(
        0,
      );
      // The upload is completed: what was PUT again does not become a second attachment.
      await complete(editor, note.id, presigned.uploadId).expect(404);
      expect(
        (
          await editor.agent
            .get(`/v1/test-items/${note.id}/attachments`)
            .expect(200)
        ).body.items,
      ).toHaveLength(1);

      // The row outlives the completion, for the sweep to delete the object that was PUT again.
      await node.db
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(attachmentUploads.id, presigned.uploadId));
      await node.app.get(AttachmentSweepJob).run();
      expect(disk.keys()).not.toContain(staging);
      expect(await uploadRow(presigned.uploadId)).toBeUndefined();
      expect(disk.keys()).toContain(attachment!.key);
      expect(Buffer.compare(await disk.getBuffer(attachment!.key), png)).toBe(
        0,
      );
      // It was not an abandoned upload: no audit entry says so.
      const swept = await node.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'attachments.uploads-swept'));
      expect(
        swept.some((entry) =>
          (entry.details as { uploads: string[] }).uploads.includes(
            presigned.uploadId,
          ),
        ),
      ).toBe(false);
    });

    it('is the announcer’s own, for the record it was announced for (404 otherwise)', async () => {
      const mine = await noteOfEditor();
      const theirs = await noteOfEditor();
      const presigned = await announce(
        mine.editor,
        mine.note.id,
        png,
        'image/png',
      );
      // Another user, even on a record of their own.
      await complete(theirs.editor, theirs.note.id, presigned.uploadId).expect(
        404,
      );
      // The same user, another record.
      const second = (
        await node
          .writeItem(mine.editor.agent, { title: 'Second', body: 'x' })
          .expect(201)
      ).body as { id: string };
      await complete(mine.editor, second.id, presigned.uploadId).expect(404);
      await complete(mine.editor, mine.note.id, randomUUID()).expect(404);
      await mine.editor.agent
        .post(`/v1/test-items/${mine.note.id}/attachments/complete`)
        .send({ uploadId: 'nope' })
        .expect(400);
      // None of it touched the upload.
      expect(await uploadRow(presigned.uploadId)).toBeDefined();
      await complete(mine.editor, mine.note.id, presigned.uploadId).expect(201);
    });

    it('makes one attachment of an upload however many times it is completed', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      const answers = await Promise.all([
        complete(editor, note.id, presigned.uploadId),
        complete(editor, note.id, presigned.uploadId),
        complete(editor, note.id, presigned.uploadId),
      ]);
      const statuses = answers.map((answer) => answer.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      // The others lost the claim (409) or came after the row was gone (404).
      for (const status of statuses.filter((status) => status !== 201)) {
        expect([404, 409]).toContain(status);
      }
      await complete(editor, note.id, presigned.uploadId).expect(404);
      const listed = await editor.agent
        .get(`/v1/test-items/${note.id}/attachments`)
        .expect(200);
      expect(listed.body.items).toHaveLength(1);
      // The attachment's file is still there: no loser deleted it.
      const [row] = await node.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, listed.body.items[0].id));
      expect(disk.keys()).toContain(row!.key);
    });

    it('answers 410 more than an hour after the URL expired, and deletes the object', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      const key = (await uploadRow(presigned.uploadId))!.key;
      await node.db
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(attachmentUploads.id, presigned.uploadId));
      const gone = await complete(editor, note.id, presigned.uploadId).expect(
        410,
      );
      expect(gone.body.code).toBe('attachment_upload_expired');
      expect(disk.keys()).not.toContain(key);
      expect(await uploadRow(presigned.uploadId)).toBeUndefined();
    });

    it('still completes shortly after the URL expired (a PUT may finish late)', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      await node.db
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 20 * 60 * 1000) })
        .where(eq(attachmentUploads.id, presigned.uploadId));
      await complete(editor, note.id, presigned.uploadId).expect(201);
    });

    it('checks the right to attach files again: the record was deleted between the PUT and the completion (404)', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      await node.admin().delete(`/v1/test-items/${note.id}`).expect(204);
      await complete(editor, note.id, presigned.uploadId).expect(404);
      // Not attached; the sweep deals with the object, and the record may come back.
      expect(
        await node.db
          .select()
          .from(attachments)
          .where(eq(attachments.recordId, note.id)),
      ).toEqual([]);
      expect(await uploadRow(presigned.uploadId)).toBeDefined();
    });
  });

  describe('the nightly sweep', () => {
    const insertUpload = async (
      expiresAt: Date,
      key = `tenants/${node.tenantId}/attachments/${randomUUID()}`,
    ) => {
      const [row] = await node.db
        .insert(attachmentUploads)
        .values({
          tenantId: node.tenantId,
          subject: 'TestItem',
          recordId: randomUUID(),
          key,
          name: 'abandoned.png',
          size: png.length,
          contentType: 'image/png',
          uploadedBy: `user:${randomUUID()}`,
          expiresAt,
        })
        .returning();
      await disk.put(key, png, { contentType: 'image/png' });
      return row!;
    };

    it('deletes the object and the row of an upload nobody completed, an hour after its URL expired', async () => {
      const abandoned = await insertUpload(
        new Date(Date.now() - 2 * 60 * 60 * 1000),
      );
      // Still within the hour its client may complete it in: left alone.
      const recent = await insertUpload(new Date(Date.now() - 10 * 60 * 1000));
      // Its URL still works.
      const fresh = await insertUpload(new Date(Date.now() + 5 * 60 * 1000));

      await node.app.get(AttachmentSweepJob).run();

      expect(disk.keys()).not.toContain(abandoned.key);
      expect(await uploadRow(abandoned.id)).toBeUndefined();
      for (const kept of [recent, fresh]) {
        expect(disk.keys()).toContain(kept.key);
        expect(await uploadRow(kept.id)).toBeDefined();
      }
      const entries = await node.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'attachments.uploads-swept'));
      const mine = entries.find((entry) =>
        (entry.details as { uploads: string[] }).uploads.includes(abandoned.id),
      );
      expect(mine).toMatchObject({
        actor: 'system:attachment-sweep',
        tenantId: node.tenantId,
      });
    });

    it('never deletes the file of an attachment, whatever the row of its upload says', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      const completed = await complete(
        editor,
        note.id,
        presigned.uploadId,
      ).expect(201);
      const [attachment] = await node.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, completed.body.id));
      // A row that outlived its completion (the delete failed) and expired.
      await insertUpload(
        new Date(Date.now() - 2 * 60 * 60 * 1000),
        attachment!.key,
      );
      await node.app.get(AttachmentSweepJob).run();
      expect(disk.keys()).toContain(attachment!.key);
      expect(
        await node.db
          .select()
          .from(attachmentUploads)
          .where(eq(attachmentUploads.key, attachment!.key)),
      ).toEqual([]);
    });

    it('lets go of the announcer when their account is deleted: the upload is nobody’s, and the sweep still removes it', async () => {
      const { editor, note } = await noteOfEditor();
      const presigned = await announce(editor, note.id, png, 'image/png');
      const key = (await uploadRow(presigned.uploadId))!.key;
      await editor.agent
        .post('/v1/account/deletion')
        .send({ password: editor.password })
        .expect(200);
      await node.app
        .get(AccountDeletionJob)
        .run(new Date(Date.now() + 15 * 86_400_000));
      expect(await uploadRow(presigned.uploadId)).toMatchObject({
        uploadedBy: ANONYMIZED_UPLOADER,
      });
      await node.db
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(attachmentUploads.id, presigned.uploadId));
      await node.app.get(AttachmentSweepJob).run();
      expect(disk.keys()).not.toContain(key);
      expect(await uploadRow(presigned.uploadId)).toBeUndefined();
    });
  });
});
