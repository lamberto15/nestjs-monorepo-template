import { randomUUID } from 'node:crypto';
import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import type { Database } from '../src/core/database/drizzle.js';
import { notes } from '../src/features/notes/notes.tables.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { AttachmentSweepJob } from '../src/platform/attachments/attachment-sweep.job.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import {
  DOCUMENT_ERRORS,
  DocumentsService,
} from '../src/platform/documents/documents.service.js';
import { documents } from '../src/platform/documents/documents.tables.js';
import { bootApp, connect, type TestApp } from './support.js';

/**
 * A stand-in for Gotenberg on loopback (no Docker pull, no Chromium),
 * started before AppModule loads: this file's apps render through it
 * (GOTENBERG_URL; unset in every other file, where documents are off). It
 * records each page it is sent, and answers each request as the next of
 * `state.answers` says (`ok` once they run out): a PDF, a refusal (400),
 * a failure (503), nothing at all (`hang`, until the client gives up), or
 * a PDF after 250 ms (`slow`).
 */
const gotenberg = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const { randomUUID: uuid } = await import('node:crypto');
  type Answer = 'ok' | 'reject' | 'down' | 'hang' | 'slow';
  const state = { answers: [] as Answer[] };
  const pages: { html: string; trace: string | undefined; path: string }[] = [];
  const pdfs: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'content-type': req.headers['content-type'] ?? '' },
        }).formData();
        const file = form.get('files') as File;
        pages.push({
          html: await file.text(),
          trace: req.headers['gotenberg-trace'] as string | undefined,
          path: req.url ?? '',
        });
        const answer = state.answers.shift() ?? 'ok';
        if (answer === 'hang') return; // answered when the server closes
        if (answer === 'reject') {
          res.writeHead(400).end('Invalid form data');
          return;
        }
        if (answer === 'down') {
          res.writeHead(503).end('Chromium crashed');
          return;
        }
        if (answer === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const pdf = Buffer.from(`%PDF-1.7\n% stub ${uuid()}\n%%EOF\n`);
        pdfs.push(pdf);
        res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    GOTENBERG_URL: `http://127.0.0.1:${port}`,
    // Short, so the timeout tests wait a moment, not 30 s; long enough for
    // a `slow` answer on a busy machine.
    GOTENBERG_TIMEOUT_MS: '1500',
    DOCUMENTS_RENDER_ATTEMPTS: '2',
  });
  return {
    state,
    pages,
    pdfs,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
});

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('documents (e2e)', () => {
  let node: TestApp;
  let db: Database;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    node = await bootApp();
    db = node.db;
  });
  beforeEach(() => {
    gotenberg.state.answers.length = 0;
    gotenberg.pages.length = 0;
  });
  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
  });
  afterAll(async () => {
    await node.close();
    await gotenberg.close();
  });

  /** An API client with a note, and its realtime connection. */
  async function owner(
    body: Record<string, unknown> = {
      title: 'Quarterly report',
      body: 'All good.',
    },
  ) {
    const client = await node.client();
    const note = (await node.writeNote(client.auth, body).expect(201)).body as {
      id: string;
      number: string;
    };
    const socket = await connect(node, client.key);
    sockets.push(socket);
    return { client, note, socket };
  }

  /** The next `event` this connection hears. */
  const next = (socket: Socket, event: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No ${event} within 10 s`)),
        10_000,
      );
      socket.once(event, (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  const ask = (auth: string, noteId: string, query = '') =>
    node
      .http()
      .post(`/v1/notes/${noteId}/pdf${query}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID());

  /** The PDFs on the disk for a document (one key per run). */
  const files = async (id: string) =>
    (
      await node.app.get(StorageDisk).list({ prefix: `documents/${id}/` })
    ).entries.map((entry) => entry.key);

  const status = (auth: string, id: string) =>
    node.http().get(`/v1/documents/${id}`).set('Authorization', auth);

  const download = async (auth: string, attachmentId: string) => {
    const link = await node
      .http()
      .get(`/v1/attachments/${attachmentId}/download`)
      .set('Authorization', auth)
      .expect(302);
    return node
      .http()
      .get(local(link.headers.location!))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
  };

  it('renders a note on a worker, issues it as a locked attachment of the note, and says so over realtime', async () => {
    const { client, note, socket } = await owner({
      title: '<script>alert("x")</script> Report',
      body: '<img src=x onerror=alert(1)>\nSecond line',
    });
    const ready = next(socket, 'document.ready');

    const asked = await ask(client.auth, note.id).expect(202);
    expect(asked.body).toEqual({ id: expect.any(String), status: 'queued' });
    const heard = await ready;
    const done = (await status(client.auth, asked.body.id).expect(200)).body;
    expect(done).toMatchObject({
      id: asked.body.id,
      source: 'note',
      subject: 'Note',
      recordId: note.id,
      locale: 'en',
      status: 'completed',
      attachmentId: expect.any(String),
      error: null,
      issuedAt: expect.any(String),
    });
    expect(heard).toEqual({
      id: asked.body.id,
      subject: 'Note',
      recordId: note.id,
      attachmentId: done.attachmentId,
    });

    // What Gotenberg got: one whole page, the values escaped, nothing remote.
    expect(gotenberg.pages).toHaveLength(1);
    const [page] = gotenberg.pages;
    expect(page!.path).toBe('/forms/chromium/convert/html');
    expect(page!.trace).toBe(asked.body.id);
    expect(page!.html).toContain('<html lang="en" dir="ltr">');
    expect(page!.html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Report',
    );
    expect(page!.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page!.html).not.toMatch(/<script|<img/);
    expect(page!.html).toContain(note.number);
    expect(page!.html).toContain("default-src 'none'");

    // The note's attachment: the stub's PDF, locked, named after the note.
    const listed = await node
      .http()
      .get(`/v1/notes/${note.id}/attachments`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        id: done.attachmentId,
        name: `${note.number}.pdf`,
        contentType: 'application/pdf',
        locked: true,
        uploadedBy: `client:${client.id}`,
      }),
    ]);
    const file = await download(client.auth, done.attachmentId);
    expect(Buffer.compare(file.body as Buffer, gotenberg.pdfs.at(-1)!)).toBe(0);
    expect(file.headers['content-type']).toBe('application/pdf');

    // Issued documents never change: not removable, and asking again issues another.
    const removed = await node
      .http()
      .delete(`/v1/attachments/${done.attachmentId}`)
      .set('Authorization', client.auth)
      .expect(409);
    expect(removed.body.code).toBe('attachment_locked');
    const again = next(socket, 'document.ready');
    const second = await ask(client.auth, note.id).expect(202);
    expect((await again).id).toBe(second.body.id);
    const both = await node
      .http()
      .get(`/v1/notes/${note.id}/attachments`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(both.body.items).toHaveLength(2);
    expect(
      Buffer.compare(
        (await download(client.auth, done.attachmentId)).body as Buffer,
        file.body as Buffer,
      ),
    ).toBe(0);

    // Audited: asked for, issued, its attachment added.
    const actions = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.targetId, asked.body.id))
    ).map((row) => row.action);
    expect(actions.sort()).toEqual(['document.issued', 'document.requested']);
  });

  it('writes the document in the language asked for: Arabic right to left', async () => {
    const { client, note, socket } = await owner({
      title: 'تقرير',
      body: 'مرحبا بالعالم',
    });
    const ready = next(socket, 'document.ready');
    const asked = await ask(client.auth, note.id, '?lang=ar').expect(202);
    await ready;
    expect((await status(client.auth, asked.body.id)).body.locale).toBe('ar');
    const [page] = gotenberg.pages;
    expect(page!.html).toContain('<html lang="ar" dir="rtl">');
    expect(page!.html).toContain('ملاحظة'); // "Note", from the ar catalog
    expect(page!.html).toContain('مرحبا بالعالم');
  });

  it('tries a failed render again, then issues it', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('down');
    const ready = next(socket, 'document.ready');
    const asked = await ask(client.auth, note.id).expect(202);
    expect((await ready).id).toBe(asked.body.id);
    expect(gotenberg.pages).toHaveLength(2);
    expect((await status(client.auth, asked.body.id)).body.status).toBe(
      'completed',
    );
  });

  it('fails without retries when Gotenberg refuses the page', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('reject');
    const failed = next(socket, 'document.failed');
    const asked = await ask(client.auth, note.id).expect(202);
    expect(await failed).toEqual({
      id: asked.body.id,
      subject: 'Note',
      recordId: note.id,
      error: DOCUMENT_ERRORS.rejected,
    });
    expect(gotenberg.pages).toHaveLength(1);
    expect((await status(client.auth, asked.body.id)).body).toMatchObject({
      status: 'failed',
      attachmentId: null,
      error: DOCUMENT_ERRORS.rejected,
    });
    // Nothing on the note, nothing on the disk.
    const listed = await node
      .http()
      .get(`/v1/notes/${note.id}/attachments`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(listed.body.items).toEqual([]);
    expect(await files(asked.body.id)).toEqual([]);
  });

  it('gives up after its attempts when Gotenberg never answers (timeouts)', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('hang', 'hang');
    const failed = next(socket, 'document.failed');
    const asked = await ask(client.auth, note.id).expect(202);
    expect(await failed).toMatchObject({
      id: asked.body.id,
      error: DOCUMENT_ERRORS.unavailable,
    });
    // DOCUMENTS_RENDER_ATTEMPTS (2): each one timed out.
    expect(gotenberg.pages).toHaveLength(2);
    expect((await status(client.auth, asked.body.id)).body.status).toBe(
      'failed',
    );
  });

  it('fails a document whose note is gone by the time it renders', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('hang'); // the first try waits; the note goes meanwhile
    const failed = next(socket, 'document.failed');
    const asked = await ask(client.auth, note.id).expect(202);
    await node
      .http()
      .delete(`/v1/notes/${note.id}`)
      .set('Authorization', client.auth)
      .expect(204);
    expect(await failed).toMatchObject({
      id: asked.body.id,
      error: DOCUMENT_ERRORS.recordGone,
    });
  });

  it('is for those who may read the note, and needs an Idempotency-Key', async () => {
    const { client, note } = await owner();
    const stranger = await node.client();
    await ask(stranger.auth, note.id).expect(404);
    await ask(client.auth, randomUUID()).expect(404);
    await node
      .http()
      .post(`/v1/notes/${note.id}/pdf`)
      .set('Authorization', client.auth)
      .expect(400);
    expect(gotenberg.pages).toHaveLength(0);

    const asked = await ask(client.auth, note.id).expect(202);
    await status(stranger.auth, asked.body.id).expect(404);
    await status(client.auth, randomUUID()).expect(404);
  });

  it("goes with its note: the sweep removes a purged note's documents, file and rows", async () => {
    const { client, note, socket } = await owner();
    const ready = next(socket, 'document.ready');
    const asked = await ask(client.auth, note.id).expect(202);
    await ready;
    const [issued] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, asked.body.id));
    const disk = node.app.get(StorageDisk);
    const [file] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, issued!.attachmentId!));
    expect(await disk.exists(file!.key)).toBe(true);

    await node
      .http()
      .delete(`/v1/notes/${note.id}`)
      .set('Authorization', client.auth)
      .expect(204);
    await db
      .update(notes)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(notes.id, note.id));
    await node.app.get(SoftDeletePurgeJob).run();
    await node.app.get(AttachmentSweepJob).run();
    expect(
      await db.select().from(documents).where(eq(documents.id, issued!.id)),
    ).toEqual([]);
    expect(await disk.exists(file!.key)).toBe(false);
  });

  it('a reader without Note.body cannot download a PDF that includes it, nor see its document', async () => {
    const { client, note, socket } = await owner({
      title: 'Salaries',
      body: 'confidential text',
    });
    const ready = next(socket, 'document.ready');
    const asked = await ask(client.auth, note.id).expect(202);
    const { attachmentId } = (await ready) as { attachmentId: string };
    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, asked.body.id));
    expect(row!.fields).toContain('body');
    expect(gotenberg.pages[0]!.html).toContain('confidential text');

    // Every note, titles only (no Note.body).
    const titlesOnly = (
      await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `Titles ${randomUUID().slice(0, 6)}`,
          permissions: [
            { subject: 'Note', action: 'read', conditions: [], fields: [] },
          ],
        })
        .expect(201)
    ).body.id as string;
    const reader = await node.user([titlesOnly]);
    expect(
      (await reader.agent.get(`/v1/notes/${note.id}`).expect(200)).body,
    ).not.toHaveProperty('body');
    await reader.agent
      .get(`/v1/attachments/${attachmentId}/download`)
      .expect(404);
    await reader.agent.get(`/v1/documents/${asked.body.id}`).expect(404);

    // Who may read the text (its author) downloads it.
    await download(client.auth, attachmentId);

    // A PDF without the text (asked for by the titles-only reader) is theirs to read.
    const ownReady = new Promise<void>((resolve) => {
      const check = async () => {
        for (let tries = 0; tries < 100; tries++) {
          const [doc] = await db
            .select()
            .from(documents)
            .where(eq(documents.requestedBy, `user:${reader.id}`));
          if (doc?.status === 'completed') return resolve();
          await new Promise((r) => setTimeout(r, 50));
        }
        resolve();
      };
      void check();
    });
    const theirs = await reader.agent
      .post(`/v1/notes/${note.id}/pdf`)
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    await ownReady;
    const shown = (
      await reader.agent.get(`/v1/documents/${theirs.body.id}`).expect(200)
    ).body;
    expect(shown.status).toBe('completed');
    expect(gotenberg.pages.at(-1)!.html).not.toContain('confidential text');
    await reader.agent
      .get(`/v1/attachments/${shown.attachmentId}/download`)
      .expect(302);
  });

  it('refuses a second request while the first is rendering (409 document_pending)', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('hang', 'hang');
    const failed = next(socket, 'document.failed');
    const first = await ask(client.auth, note.id).expect(202);
    const again = await ask(client.auth, note.id).expect(409);
    expect(again.body).toMatchObject({
      code: 'document_pending',
      id: first.body.id,
    });
    // Another language is another document.
    gotenberg.state.answers.push('reject');
    await ask(client.auth, note.id, '?lang=de').expect(202);
    await failed;
    // Once it failed, asking again is allowed.
    const ready = next(socket, 'document.ready');
    await ask(client.auth, note.id).expect(202);
    await ready;
  });

  it('issues one PDF when a document is rendered twice at once (a stalled job run again)', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('slow', 'slow');
    const ready = next(socket, 'document.ready');
    const asked = await ask(client.auth, note.id).expect(202);
    // Wait until the queued run claimed it, then start a second run, as
    // BullMQ does with a stalled job: the later claim wins.
    for (let tries = 0; tries < 100; tries++) {
      const [row] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, asked.body.id));
      if (row?.status === 'rendering') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const service = node.app.get(DocumentsService);
    const principal = {
      kind: 'client' as const,
      id: client.id,
      name: 'x',
      tenantId: node.tenantId,
    };
    // Its rejection (it may lose the claim) is the test's to read, not unhandled.
    const second = node
      .inTenant(() =>
        service.issue(
          { id: asked.body.id, principal, tenantId: node.tenantId },
          principal,
          {
            final: false,
          },
        ),
      )
      .catch((error: unknown) => error);
    await ready;
    await second;
    // Let the losing run finish and clean up after itself.
    for (
      let tries = 0;
      tries < 100 && (await files(asked.body.id)).length > 1;
      tries++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const listed = await node
      .http()
      .get(`/v1/notes/${note.id}/attachments`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(await files(asked.body.id)).toHaveLength(1);
    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, asked.body.id));
    expect(row!.status).toBe('completed');
    const [attachment] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, row!.attachmentId!));
    expect(await files(asked.body.id)).toEqual([attachment!.key]);
    // Run again once issued: nothing changes.
    await node.inTenant(() =>
      service.issue(
        { id: asked.body.id, principal, tenantId: node.tenantId },
        principal,
        {
          final: false,
        },
      ),
    );
    expect(await files(asked.body.id)).toEqual([attachment!.key]);
  });

  it('fails a document once: a second fail() changes, audits and tells nothing', async () => {
    const { client, note, socket } = await owner();
    gotenberg.state.answers.push('reject');
    const failed = next(socket, 'document.failed');
    const asked = await ask(client.auth, note.id).expect(202);
    await failed;
    const audited = async () =>
      (
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, asked.body.id))
      ).filter((row) => row.action === 'document.failed').length;
    expect(await audited()).toBe(1);
    let heard = 0;
    socket.on('document.failed', () => heard++);
    await node
      .inTenant(() =>
        node.app.get(DocumentsService).fail(
          {
            id: asked.body.id,
            tenantId: node.tenantId,
            principal: {
              kind: 'client',
              id: client.id,
              name: 'x',
              tenantId: node.tenantId,
            },
          },
          'again',
        ),
      )
      .catch((error: unknown) => error);
    await new Promise((r) => setTimeout(r, 100));
    expect(await audited()).toBe(1);
    expect(heard).toBe(0);
    expect((await status(client.auth, asked.body.id)).body.error).toBe(
      DOCUMENT_ERRORS.rejected,
    );
  });

  it('limits a user to 10 requests a minute (429)', async () => {
    const editor = await node.user(['editor']);
    const note = (
      await node.writeNote(editor.agent, { title: 'T', body: 'b' }).expect(201)
    ).body as { id: string };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (
          await editor.agent
            .post(`/v1/notes/${note.id}/pdf`)
            .set('Idempotency-Key', randomUUID())
        ).status,
      );
    }
    expect(
      codes.slice(0, 10).every((code) => code === 202 || code === 409),
    ).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
