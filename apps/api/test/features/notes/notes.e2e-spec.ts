import { writeNote, exampleSender } from './notes-support.js';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { NotesService } from '../../../src/features/notes/notes.service.js';
import { auditLog } from '../../../src/iam/iam.tables.js';
import { notes } from '../../../src/features/notes/notes.tables.js';
import { revisions } from '../../../src/platform/revisions/revisions.tables.js';
import { notifications } from '../../../src/platform/notifications/notifications.tables.js';
import { recordSubscriptions } from '../../../src/platform/subscriptions/subscriptions.tables.js';
import { publicationId } from '../../../src/features/notes/note-publication.workflow.js';
import { noteSchema } from '../../../src/features/notes/note.schemas.js';
import { bootApp, webhookReceiver, type TestApp } from '../../support.js';

describe('the example feature: notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it('aggregates weekly counts while respecting the caller’s note access', async () => {
    const client = await node.client();
    await writeNote(node, client.auth, {
      title: 'Dashboard count',
      body: 'Visible to this client.',
    }).expect(201);

    const now = new Date();
    const monday = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - ((now.getUTCDay() + 6) % 7),
      ),
    );
    const from = new Date(monday.getTime() - 7 * 7 * 24 * 60 * 60 * 1000);
    const response = await node
      .http()
      .get('/v1/notes/dashboard/weekly-counts')
      .query({ from: from.toISOString().slice(0, 10), weeks: 8 })
      .set('Authorization', client.auth)
      .expect(200);

    expect(response.body).toHaveLength(8);
    expect(response.body.at(-1)).toEqual({
      week: monday.toISOString().slice(0, 10),
      count: 1,
    });
    await node
      .http()
      .get('/v1/notes/dashboard/weekly-counts')
      .query({
        from: new Date(from.getTime() + 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      })
      .set('Authorization', client.auth)
      .expect(400);
  });

  it('keeps grouped create and update side effects equivalent to single writes', async () => {
    const client = await node.client();
    const principal = {
      kind: 'client' as const,
      id: client.id,
      name: 'batch client',
      tenantId: node.tenantId,
    };
    const service = node.app.get(NotesService);
    const dtos = [
      { title: 'Batch A', body: 'one' },
      { title: 'Batch B', body: 'two' },
      { title: 'Single A', body: 'one' },
      { title: 'Single B', body: 'two' },
    ];
    const beforeOutbox = await node.db.execute(
      sql`select count(*)::int as count from nest_outbox.messages`,
    );
    const [created, singles] = await node.inTenant(async () =>
      Promise.all([
        service.createMany(principal, dtos.slice(0, 2)),
        Promise.all(dtos.slice(2).map((dto) => service.create(principal, dto))),
      ]),
    );
    const all = [...created, ...singles];
    const ids = all.map((note) => note.id);
    const firstRevisionCounts = await node.inTenant(async () =>
      Promise.all([
        node.db.select().from(auditLog).where(inArray(auditLog.targetId, ids)),
        node.db
          .select()
          .from(revisions)
          .where(inArray(revisions.recordId, ids)),
        node.db
          .select()
          .from(recordSubscriptions)
          .where(inArray(recordSubscriptions.recordId, ids)),
      ]),
    );
    expect(firstRevisionCounts.map((rows) => rows.length)).toEqual([4, 4, 4]);
    const afterCreateOutbox = await node.db.execute(
      sql`select count(*)::int as count from nest_outbox.messages`,
    );
    expect(
      Number(
        (afterCreateOutbox as { rows: { count: number }[] }).rows[0]!.count,
      ) -
        Number((beforeOutbox as { rows: { count: number }[] }).rows[0]!.count),
    ).toBe(4);

    const admin = node.admin();
    const adminId = (await admin.get('/v1/auth/me').expect(200)).body.user
      .id as string;
    for (const note of all)
      await admin.post(`/v1/notes/${note.id}/watch`).expect(200);
    const batchMatches = created.map((note, index) => ({
      noteId: note.id,
      dto: { title: `Changed ${index}` },
    }));
    const updated = await node.inTenant(() =>
      service.updateMany(principal, batchMatches),
    );
    const updatedSingles = await node.inTenant(() =>
      Promise.all(
        singles.map((note, index) =>
          service.update(principal, note, { title: `Changed ${index + 2}` }),
        ),
      ),
    );
    const current = await node.inTenant(() =>
      node.db.select().from(notes).where(inArray(notes.id, ids)),
    );
    expect(
      current
        .map(({ id, title, body }) => ({ id, title, body }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      [...updated, ...updatedSingles]
        .map(({ id, title, body }) => ({ id, title, body }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    const [audits, revisionsAfter, subscriptionsAfter, notices] =
      await node.inTenant(async () =>
        Promise.all([
          node.db
            .select()
            .from(auditLog)
            .where(inArray(auditLog.targetId, ids)),
          node.db
            .select()
            .from(revisions)
            .where(inArray(revisions.recordId, ids)),
          node.db
            .select()
            .from(recordSubscriptions)
            .where(inArray(recordSubscriptions.recordId, ids)),
          node.db
            .select()
            .from(notifications)
            .where(inArray(notifications.recipient, [`user:${adminId}`])),
        ]),
      );
    expect(
      audits.filter((entry) => entry.action === 'note.updated'),
    ).toHaveLength(4);
    expect(revisionsAfter).toHaveLength(8);
    expect(subscriptionsAfter).toHaveLength(8);
    expect(
      notices.filter((notice) => ids.includes(String(notice.data.noteId))),
    ).toHaveLength(4);
  });

  it('reserves gapless numbers across concurrent groups', async () => {
    const client = await node.client();
    const principal = {
      kind: 'client' as const,
      id: client.id,
      name: 'batch client',
      tenantId: node.tenantId,
    };
    const service = node.app.get(NotesService);
    const make = (prefix: string) =>
      Array.from({ length: 4 }, (_, index) => ({
        title: `${prefix} ${index}`,
        body: '',
      }));
    const groups = await node.inTenant(() =>
      Promise.all([
        service.createMany(principal, make('Concurrent A')),
        service.createMany(principal, make('Concurrent B')),
      ]),
    );
    const numbers = groups
      .flat()
      .map((note) => Number(note.number!.split('-').at(-1)))
      .sort((a, b) => a - b);
    expect(numbers).toHaveLength(8);
    expect(new Set(numbers).size).toBe(8);
    expect(
      numbers.slice(1).map((number, index) => number - numbers[index]!),
    ).toEqual(Array(7).fill(1));
  });

  describe('idempotency', () => {
    it('requires an Idempotency-Key, and replays a retry instead of writing twice', async () => {
      const client = await node.client();
      await node
        .http()
        .post('/v1/notes')
        .set('Authorization', client.auth)
        .send({ title: 'No key', body: '' })
        .expect(400);

      const key = randomUUID();
      const first = await writeNote(node, client.auth, undefined, key).expect(
        201,
      );
      const retry = await writeNote(node, client.auth, undefined, key).expect(
        201,
      );
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.id).toBe(first.body.id);

      // The same key with another body is a mistake, not a retry.
      await writeNote(
        node,
        client.auth,
        { title: 'Other', body: '' },
        key,
      ).expect(422);
      const notes = await node
        .http()
        .get('/v1/notes')
        .set('Authorization', client.auth);
      expect(notes.body.items).toHaveLength(1);
    });

    it('scopes keys per caller: two clients never replay each other', async () => {
      const [a, b] = [await node.client(), await node.client()];
      const key = randomUUID();
      const first = await writeNote(node, a.auth, undefined, key).expect(201);
      const second = await writeNote(node, b.auth, undefined, key).expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('permissions', () => {
    it('pages and filters lists the same way everywhere', async () => {
      const client = await node.client();
      for (const title of ['Alpha report', 'Beta notes', 'Gamma report']) {
        await writeNote(node, client.auth, { title, body: 'x' }).expect(201);
      }
      const list = (query: string) =>
        node.http().get(`/v1/notes${query}`).set('Authorization', client.auth);

      const first = await list('?limit=2').expect(200);
      expect(first.body.items.map((n: { title: string }) => n.title)).toEqual([
        'Gamma report',
        'Beta notes',
      ]);
      const second = await list(
        `?limit=2&cursor=${first.body.nextCursor}`,
      ).expect(200);
      expect(second.body).toEqual({
        items: [expect.objectContaining({ title: 'Alpha report' })],
        nextCursor: null,
      });

      const reports = await list(
        '?title.contains=REPORT&status.in=draft,published',
      ).expect(200);
      expect(reports.body.items).toHaveLength(2);
      const wildcard = await list('?title.contains=%25').expect(200);
      expect(wildcard.body.items).toHaveLength(0); // % is a character, not a wildcard
      await list('?status=archived').expect(400);
      const unknown = await list('?secret=1').expect(400);
      expect(unknown.body.code).toBe('validation_failed');
      await list('?createdAt.gte=yesterday').expect(400);
      await list(
        '?publishedAt.isNull=true&createdAt.gte=2000-01-01T00:00:00Z',
      ).expect(200);
    });

    it('changes a note, audited with what changed (from → to)', async () => {
      const client = await node.client();
      const created = await writeNote(node, client.auth, {
        title: 'Draft',
        body: 'v1',
      }).expect(201);
      const id = created.body.id as string;
      const changed = await node
        .http()
        .patch(`/v1/notes/${id}`)
        .set('Authorization', client.auth)
        .send({ title: 'Final' })
        .expect(200);
      expect(changed.body).toMatchObject({ id, title: 'Final', body: 'v1' });
      const audit = await node
        .admin()
        .get(`/v1/access/audit?targetId=${id}`)
        .expect(200);
      expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
        ['note.updated', 'note.created'],
      );
      expect(audit.body.items[0].details).toEqual({
        changes: { title: { from: 'Draft', to: 'Final' } },
      });
    });

    it('applies field-level permissions to reads and writes', async () => {
      const writer = await node.client();
      await writeNote(node, writer.auth, {
        title: 'Secret plan',
        body: 'the text',
      }).expect(201);
      const role = await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `Title only ${Date.now()}`,
          permissions: [{ subject: 'Note', action: 'read', conditions: [] }],
        })
        .expect(201);
      await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: 'Bad',
          permissions: [
            {
              subject: 'Note',
              action: 'read',
              conditions: [],
              fields: ['nope'],
            },
          ],
        })
        .expect(400);
      // Without `fields`, a permission covers every field...
      const reader = await node.user([role.body.id]);
      const all = await reader.agent.get('/v1/notes').expect(200);
      expect(all.body.items[0]).toHaveProperty('body');

      // ...with `fields: []`, none of the restrictable ones (the text), only the rest.
      const titleOnly = await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `Titles ${Date.now()}`,
          permissions: [
            { subject: 'Note', action: 'read', conditions: [], fields: [] },
            { subject: 'Note', action: 'create', conditions: [] },
            {
              subject: 'Note',
              action: 'update',
              conditions: [{ key: 'mine' }, { key: 'draft' }],
              fields: [],
            },
          ],
        })
        .expect(201);
      const limited = await node.user([titleOnly.body.id]);
      const listed = await limited.agent.get('/v1/notes').expect(200);
      expect(listed.body.items[0]).toMatchObject({ title: 'Secret plan' });
      expect(listed.body.items[0]).not.toHaveProperty('body');

      const own = await writeNote(node, limited.agent, {
        title: 'Mine',
        body: 'x',
      }).expect(201);
      await limited.agent
        .patch(`/v1/notes/${own.body.id}`)
        .send({ title: 'Renamed' })
        .expect(200);
      const refused = await limited.agent
        .patch(`/v1/notes/${own.body.id}`)
        .send({ body: 'new text' })
        .expect(403);
      expect(refused.body).toMatchObject({
        code: 'field_forbidden',
        fields: ['body'],
      });
    });

    it('lists only what the caller may read, filtered in the query', async () => {
      const [a, b] = [await node.client(), await node.client()];
      await writeNote(node, a.auth).expect(201);
      await writeNote(node, b.auth).expect(201);
      const editor = (await node.user(['editor'])).agent;
      await writeNote(node, editor).expect(201);

      const asA = await node
        .http()
        .get('/v1/notes')
        .set('Authorization', a.auth);
      expect(asA.body.items).toHaveLength(1);
      expect((await editor.get('/v1/notes')).body.items).toHaveLength(1); // their own
      const viewer = (await node.user(['viewer'])).agent;
      expect((await viewer.get('/v1/notes')).body.items).toHaveLength(3); // all
    });

    it("checks one note against its conditions: another client's is 403", async () => {
      const [a, b] = [await node.client(), await node.client()];
      const note = (await writeNote(node, a.auth).expect(201)).body;
      await node
        .http()
        .get(`/v1/notes/${note.id}`)
        .set('Authorization', b.auth)
        .expect(403);
      await node
        .http()
        .delete(`/v1/notes/${note.id}`)
        .set('Authorization', b.auth)
        .expect(403);
      await node
        .http()
        .get(`/v1/notes/${note.id}`)
        .set('Authorization', a.auth)
        .expect(200);
    });

    it('lets a viewer read but not write: 403', async () => {
      const viewer = (await node.user(['viewer'])).agent;
      await writeNote(node, viewer).expect(403);
    });

    it('deletes only drafts (Created by me AND Still a draft), and audits it', async () => {
      const client = await node.client();
      const note = (await writeNote(node, client.auth).expect(201)).body;
      await node
        .http()
        .delete(`/v1/notes/${note.id}`)
        .set('Authorization', client.auth)
        .expect(204);
      await node
        .http()
        .get(`/v1/notes/${note.id}`)
        .set('Authorization', client.auth)
        .expect(404);

      const published = (await writeNote(node, client.auth).expect(201)).body;
      await node.worker.drain();
      node.clock.advance('10s');
      await node.worker.drain();
      await node
        .http()
        .delete(`/v1/notes/${published.id}`)
        .set('Authorization', client.auth)
        .expect(403);

      const audit = await node.admin().get('/v1/access/audit');
      expect(
        audit.body.items.map((e: { action: string }) => e.action),
      ).toContain('note.deleted');
    });
  });

  // What the web app's note page needs (#106): one ETag from create to
  // write, and what the reader may do with the note now.
  describe('record pages', () => {
    /** The answer is the documented schema, no more (no tenantId): strict. */
    const conforms = (body: unknown) =>
      expect(noteSchema.strict().safeParse(body).error?.issues ?? []).toEqual(
        [],
      );

    it("answers a create with GET's strong ETag, good as If-Match at once", async () => {
      const editor = (await node.user(['editor'])).agent;
      const created = await writeNote(node, editor).expect(201);
      const etag = created.headers.etag as string;
      expect(etag).toMatch(/^"[\w-]+"$/);
      conforms(created.body);
      expect(created.body).not.toHaveProperty('tenantId');
      const shown = await editor
        .get(`/v1/notes/${created.body.id}`)
        .expect(200);
      expect(shown.headers.etag).toBe(etag);
      conforms(shown.body);
      // The list's items too.
      conforms(
        (await editor.get('/v1/notes').expect(200)).body.items[0] as unknown,
      );
      await editor
        .patch(`/v1/notes/${created.body.id}`)
        .set('If-Match', etag)
        .send({ title: 'Changed' })
        .expect(200);
      // The create's tag is spent once the note changed.
      await editor
        .patch(`/v1/notes/${created.body.id}`)
        .set('If-Match', etag)
        .send({ title: 'Again' })
        .expect(412);
    });

    it("says what the reader may do (?include=can): an editor's draft, then published, then the admin", async () => {
      const editor = (await node.user(['editor'])).agent;
      const note = (await writeNote(node, editor).expect(201)).body;
      const read = (agent = editor) =>
        agent.get(`/v1/notes/${note.id}?include=can`).expect(200);
      const draft = await read();
      conforms(draft.body);
      expect(draft.body.can).toEqual({
        update: true,
        delete: true,
        restore: false,
        issue: false,
      });
      // Not part of the tag: the If-Match of a page that asked for `can` works.
      await editor
        .patch(`/v1/notes/${note.id}`)
        .set('If-Match', draft.headers.etag as string)
        .send({ title: 'Edited' })
        .expect(200);

      await node.worker.drain();
      node.clock.advance('10s');
      await node.worker.drain();
      const published = await read();
      expect(published.body.status).toBe('published');
      expect(published.body.can).toEqual({
        update: false,
        delete: false,
        restore: false,
        issue: false,
      });
      // As the routes decide.
      await editor
        .patch(`/v1/notes/${note.id}`)
        .send({ title: 'Too late' })
        .expect(403);
      await editor.delete(`/v1/notes/${note.id}`).expect(403);
      const listed = await editor.get('/v1/notes?include=can').expect(200);
      expect(
        listed.body.items.find((item: { id: string }) => item.id === note.id)
          .can,
      ).toEqual(published.body.can);

      const admin = node.admin();
      expect((await read(admin)).body.can).toEqual({
        update: true,
        delete: true,
        restore: false,
        issue: false,
      });
      await admin.delete(`/v1/notes/${note.id}`).expect(204);
      const bin = await admin
        .get('/v1/notes?deleted=true&include=can')
        .expect(200);
      expect(
        bin.body.items.find((item: { id: string }) => item.id === note.id).can,
      ).toEqual({
        update: false,
        delete: false,
        restore: true,
        issue: false,
      });
    });

    it("evaluates an API client's own: its drafts, not another client's", async () => {
      const [a, b] = [await node.client(), await node.client()];
      const note = (await writeNote(node, a.auth).expect(201)).body;
      const page = await node
        .http()
        .get('/v1/notes?include=can&fields=title')
        .set('Authorization', a.auth)
        .expect(200);
      expect(page.body.items).toEqual([
        {
          id: note.id,
          title: note.title,
          can: { update: true, delete: true, restore: false, issue: false },
        },
      ]);
      expect(
        (
          await node
            .http()
            .get('/v1/notes?include=can')
            .set('Authorization', b.auth)
            .expect(200)
        ).body.items,
      ).toEqual([]);
      await node
        .http()
        .get('/v1/notes?include=nothing')
        .set('Authorization', a.auth)
        .expect(400);
    });
  });

  describe('the durable workflow', () => {
    it('publishes a draft when its delay is over', async () => {
      const client = await node.client();
      const note = (await writeNote(node, client.auth).expect(201)).body;
      await node.worker.drain();
      expect(
        await node.workflows.getStatus(publicationId(note.id)),
      ).toMatchObject({
        status: 'suspended',
        customStatus: 'waiting',
      });

      node.clock.advance('10s');
      await node.worker.drain();
      expect(
        await node.workflows.getStatus(publicationId(note.id)),
      ).toMatchObject({
        status: 'completed',
        output: { published: true, trigger: 'delay' },
      });
      const after = await node
        .http()
        .get(`/v1/notes/${note.id}`)
        .set('Authorization', client.auth);
      expect(after.body.status).toBe('published');
    });
  });

  describe('webhooks', () => {
    it('delivers note.created and note.published, signed, to the owning client only', async () => {
      const receiver = await webhookReceiver();
      try {
        const [a, b] = [await node.client(), await node.client()];
        const endpoint = await node
          .http()
          .post('/v1/webhook-endpoints')
          .set('Authorization', a.auth)
          .send({ url: receiver.url, eventTypes: ['*'] })
          .expect(201);
        expect(endpoint.body.secret).toMatch(/^whsec_/);

        await writeNote(node, b.auth).expect(201); // not a's: no webhook to a
        const note = (await writeNote(node, a.auth).expect(201)).body;
        await node.deliverWebhooks();
        await node.worker.drain();
        node.clock.advance('10s');
        await node.worker.drain();
        await node.deliverWebhooks();

        expect(receiver.received.map((w) => w.body.type)).toEqual([
          'note.created',
          'note.published',
        ]);
        expect(receiver.received[0].body.data).toEqual({
          noteId: note.id,
          title: 'Hello',
        });
        expect(receiver.received[0].headers['webhook-signature']).toMatch(
          /^v1,/,
        );

        const log = await node
          .http()
          .get('/v1/webhook-deliveries')
          .set('Authorization', a.auth)
          .expect(200);
        expect(
          log.body.items.every(
            (d: { status: string }) => d.status === 'succeeded',
          ),
        ).toBe(true);
        // Another client can't see a's endpoint: 404, not 403.
        await node
          .http()
          .get(`/v1/webhook-endpoints/${endpoint.body.id}`)
          .set('Authorization', b.auth)
          .expect(404);
      } finally {
        await receiver.close();
      }
    });

    it('accepts a verified incoming webhook once, and refuses a bad signature', async () => {
      const client = await node.client();
      const note = (await writeNote(node, client.auth).expect(201)).body;
      await node.worker.drain();

      // The route is public: the event names the note's tenant (docs/tenancy.md).
      const payload = {
        type: 'note.publish-requested',
        data: { noteId: note.id, tenantId: node.tenantId },
      };
      // Another tenant's id finds no such note there: 404, nothing recorded.
      await exampleSender(node, {
        ...payload,
        data: { noteId: note.id, tenantId: randomUUID() },
      }).expect(404);
      await exampleSender(node, payload, {
        secret: `whsec_${Buffer.from(randomUUID()).toString('base64')}`,
      }).expect(401);

      const id = `msg_${randomUUID()}`;
      const first = await exampleSender(node, payload, { id }).expect(200);
      expect(first.body).toEqual({ received: true, duplicate: false });
      // The sender's retry of the same event id: answered 200 without running the handler.
      await exampleSender(node, payload, { id }).expect(200);

      // The signal wakes the workflow before its delay.
      await node.worker.drain();
      expect(
        await node.workflows.getStatus(publicationId(note.id)),
      ).toMatchObject({
        status: 'completed',
        output: { published: true, trigger: 'now' },
      });
    });
  });
});
