import { randomUUID } from 'node:crypto';
import { publicationId } from '../src/features/notes/note-publication.workflow.js';
import { bootApp, webhookReceiver, type TestApp } from './support.js';

describe('the example feature: notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
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
      const first = await node
        .writeNote(client.auth, undefined, key)
        .expect(201);
      const retry = await node
        .writeNote(client.auth, undefined, key)
        .expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.id).toBe(first.body.id);

      // The same key with another body is a mistake, not a retry.
      await node
        .writeNote(client.auth, { title: 'Other', body: '' }, key)
        .expect(422);
      const notes = await node
        .http()
        .get('/v1/notes')
        .set('Authorization', client.auth);
      expect(notes.body.items).toHaveLength(1);
    });

    it('scopes keys per caller: two clients never replay each other', async () => {
      const [a, b] = [await node.client(), await node.client()];
      const key = randomUUID();
      const first = await node.writeNote(a.auth, undefined, key).expect(201);
      const second = await node.writeNote(b.auth, undefined, key).expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('permissions', () => {
    it('pages and filters lists the same way everywhere', async () => {
      const client = await node.client();
      for (const title of ['Alpha report', 'Beta notes', 'Gamma report']) {
        await node.writeNote(client.auth, { title, body: 'x' }).expect(201);
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
      const created = await node
        .writeNote(client.auth, { title: 'Draft', body: 'v1' })
        .expect(201);
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
      await node
        .writeNote(writer.auth, { title: 'Secret plan', body: 'the text' })
        .expect(201);
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

      const own = await node
        .writeNote(limited.agent, { title: 'Mine', body: 'x' })
        .expect(201);
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
      await node.writeNote(a.auth).expect(201);
      await node.writeNote(b.auth).expect(201);
      const editor = (await node.user(['editor'])).agent;
      await node.writeNote(editor).expect(201);

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
      const note = (await node.writeNote(a.auth).expect(201)).body;
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
      await node.writeNote(viewer).expect(403);
    });

    it('deletes only drafts (Created by me AND Still a draft), and audits it', async () => {
      const client = await node.client();
      const note = (await node.writeNote(client.auth).expect(201)).body;
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

      const published = (await node.writeNote(client.auth).expect(201)).body;
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

  describe('the durable workflow', () => {
    it('publishes a draft when its delay is over', async () => {
      const client = await node.client();
      const note = (await node.writeNote(client.auth).expect(201)).body;
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

        await node.writeNote(b.auth).expect(201); // not a's: no webhook to a
        const note = (await node.writeNote(a.auth).expect(201)).body;
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
      const note = (await node.writeNote(client.auth).expect(201)).body;
      await node.worker.drain();

      // The route is public: the event names the note's tenant (docs/tenancy.md).
      const payload = {
        type: 'note.publish-requested',
        data: { noteId: note.id, tenantId: note.tenantId as string },
      };
      // Another tenant's id finds no such note there: 404, nothing recorded.
      await node
        .exampleSender({
          ...payload,
          data: { noteId: note.id, tenantId: randomUUID() },
        })
        .expect(404);
      await node
        .exampleSender(payload, {
          secret: `whsec_${Buffer.from(randomUUID()).toString('base64')}`,
        })
        .expect(401);

      const id = `msg_${randomUUID()}`;
      const first = await node.exampleSender(payload, { id }).expect(200);
      expect(first.body).toEqual({ received: true, duplicate: false });
      // The sender's retry of the same event id: answered 200 without running the handler.
      await node.exampleSender(payload, { id }).expect(200);

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
