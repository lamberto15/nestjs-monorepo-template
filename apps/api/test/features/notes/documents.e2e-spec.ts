import { writeNote } from './notes-support.js';
import { bootApp, connect, type TestApp } from '../../support.js';
import type { Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';

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

describe('documents: the note template (e2e)', () => {
  let node: TestApp;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    node = await bootApp();
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

  const ask = (auth: string, noteId: string, query = '') =>
    node
      .http()
      .post(`/v1/notes/${noteId}/pdf${query}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID());

  const ready = (socket: Socket) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('No document.ready')),
        10_000,
      );
      socket.once('document.ready', (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  async function owner() {
    const client = await node.client();
    const note = (
      await writeNote(node, client.auth, {
        title: 'تقرير',
        body: 'مرحبا بالعالم',
      }).expect(201)
    ).body as { id: string; number: string };
    const socket = await connect(node, client.key);
    sockets.push(socket);
    return { client, note, socket };
  }

  it('renders a note with its number, named after it, in English', async () => {
    const { client, note, socket } = await owner();
    const done = ready(socket);
    const asked = await ask(client.auth, note.id).expect(202);
    await done;
    const [page] = gotenberg.pages;
    expect(page!.html).toContain(note.number);
    const listed = await node
      .http()
      .get(`/v1/notes/${note.id}/attachments`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        name: `${note.number}.pdf`,
        contentType: 'application/pdf',
        locked: true,
      }),
    ]);
    expect(asked.body.status).toBe('queued');
  });

  it('writes the note document in Arabic, right to left, with its catalog', async () => {
    const { client, note, socket } = await owner();
    const done = ready(socket);
    await ask(client.auth, note.id, '?lang=ar').expect(202);
    await done;
    const [page] = gotenberg.pages;
    expect(page!.html).toContain('<html lang="ar" dir="rtl">');
    expect(page!.html).toContain('ملاحظة'); // "Note", from the ar catalog
    expect(page!.html).toContain('مرحبا بالعالم');
  });
});
