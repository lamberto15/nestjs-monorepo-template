import { randomUUID } from 'node:crypto';
import { bootApp, webhookReceiver, type TestApp } from './support.js';

/**
 * An API client's webhooks managed by a signed-in administrator
 * (`/v1/access/clients/{clientId}/…`), the event types catalog, the test
 * event, the paged delivery log and its recorded request
 * (docs/webhooks-and-realtime.md).
 */
describe('Webhooks managed by administrators (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  const base = (clientId: string) => `/v1/access/clients/${clientId}`;

  describe('GET /v1/webhook-event-types', () => {
    it("lists the declared types by feature, with the platform's, for a user and a client", async () => {
      const res = await node.admin().get('/v1/webhook-event-types').expect(200);
      const groups = res.body.items as {
        group: string;
        types: { type: string; description: string | null }[];
      }[];
      const types = groups.flatMap((g) => g.types.map((t) => t.type));
      expect(types).toContain('notification.created');
      expect(types).toContain('approval.requested');
      expect(types).not.toContain('webhook.test');
      // Each type once, under its group.
      expect(new Set(types).size).toBe(types.length);
      const approval = groups.find((g) => g.group === 'approval');
      expect(approval?.types.every((t) => t.type.startsWith('approval.'))).toBe(
        true,
      );

      const client = await node.client();
      const asClient = await node
        .http()
        .get('/v1/webhook-event-types')
        .set('Authorization', client.auth)
        .expect(200);
      expect(asClient.body).toEqual(res.body);
      await node.http().get('/v1/webhook-event-types').expect(401);
    });
  });

  describe('delegated routes', () => {
    it("manage a client's endpoints, which the client then sees as its own; audited as the administrator's", async () => {
      const client = await node.client();
      const created = await node
        .admin()
        .post(`${base(client.id)}/webhook-endpoints`)
        .send({
          url: 'https://hooks.example.com/in',
          eventTypes: ['notification.created'],
          description: 'CRM',
        })
        .expect(201);
      expect(created.body.secret).toMatch(/^whsec_/);
      const id = created.body.id as string;

      const own = await node
        .http()
        .get(`/v1/webhook-endpoints/${id}`)
        .set('Authorization', client.auth)
        .expect(200);
      expect(own.body).toMatchObject({ id, description: 'CRM' });

      const list = await node
        .admin()
        .get(`${base(client.id)}/webhook-endpoints`)
        .expect(200);
      expect(list.body.items.map((e: { id: string }) => e.id)).toEqual([id]);

      // description: null clears it; an empty string is refused.
      await node
        .admin()
        .patch(`${base(client.id)}/webhook-endpoints/${id}`)
        .send({ description: '' })
        .expect(400);
      const cleared = await node
        .admin()
        .patch(`${base(client.id)}/webhook-endpoints/${id}`)
        .send({ description: null })
        .expect(200);
      expect(cleared.body.description).toBeNull();

      const rotated = await node
        .admin()
        .post(`${base(client.id)}/webhook-endpoints/${id}/rotate-secret`)
        .expect(200);
      expect(rotated.body.secret).toMatch(/^whsec_/);

      const actions = (await node.auditEntries({ targetId: client.id })).map(
        (entry) => entry.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining([
          'webhook-endpoint.created',
          'webhook-endpoint.updated',
          'webhook-endpoint.secret-rotated',
        ]),
      );

      await node
        .admin()
        .delete(`${base(client.id)}/webhook-endpoints/${id}`)
        .expect(204);
      await node
        .http()
        .get(`/v1/webhook-endpoints/${id}`)
        .set('Authorization', client.auth)
        .expect(404);
    });

    it("keeps another client's endpoint out (404) and refuses the reserved test type", async () => {
      const [a, b] = [await node.client(), await node.client()];
      const endpoint = await node
        .http()
        .post('/v1/webhook-endpoints')
        .set('Authorization', a.auth)
        .send({ url: 'https://hooks.example.com/a', eventTypes: ['*'] })
        .expect(201);
      await node
        .admin()
        .get(`${base(b.id)}/webhook-endpoints/${endpoint.body.id}`)
        .expect(404);
      await node
        .admin()
        .get(`${base(randomUUID())}/webhook-endpoints`)
        .expect(404);
      await node
        .admin()
        .post(`${base(a.id)}/webhook-endpoints`)
        .send({
          url: 'https://hooks.example.com/t',
          eventTypes: ['webhook.test'],
        })
        .expect(400);
    });

    it('refuse an API key (401), a user without the permission (403), and another tenant (404)', async () => {
      const client = await node.client();
      await node
        .http()
        .get(`${base(client.id)}/webhook-endpoints`)
        .set('Authorization', client.auth)
        .expect(401);

      const viewer = await node.user(['viewer']);
      await viewer.agent
        .get(`${base(client.id)}/webhook-endpoints`)
        .expect(403);

      const other = await node.otherTenant();
      await other.admin.get(`${base(client.id)}/webhook-endpoints`).expect(404);
    });
  });

  describe('the test event and the delivery log', () => {
    it('sends webhook.test to the one endpoint, records its request, and pages the log', async () => {
      const receiver = await webhookReceiver();
      try {
        const client = await node.client();
        // Subscribed to something else: the test reaches it anyway.
        const endpoint = await node
          .admin()
          .post(`${base(client.id)}/webhook-endpoints`)
          .send({ url: receiver.url, eventTypes: ['approval.requested'] })
          .expect(201);

        const tested = await node
          .admin()
          .post(`${base(client.id)}/webhook-endpoints/${endpoint.body.id}/test`)
          .expect(202);
        expect(tested.body).toMatchObject({
          endpointId: endpoint.body.id,
          type: 'webhook.test',
          status: 'pending',
        });
        expect(tested.body.id).toMatch(/^dlv_[0-9a-f]{32}$/);

        // Through the client's own route too.
        const second = await node
          .http()
          .post(`/v1/webhook-endpoints/${endpoint.body.id}/test`)
          .set('Authorization', client.auth)
          .expect(202);

        await node.deliverWebhooks();
        expect(receiver.received.map((w) => w.body.type)).toEqual([
          'webhook.test',
          'webhook.test',
        ]);
        expect(receiver.received[0].body.data).toEqual({
          endpointId: endpoint.body.id,
          test: true,
        });

        const delivery = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries/${tested.body.id}`)
          .expect(200);
        expect(delivery.body.status).toBe('succeeded');
        expect(delivery.body.durationMs).toBeGreaterThanOrEqual(0);
        expect(delivery.body.lastRequest).toMatchObject({ attempt: 1 });
        expect(delivery.body.lastRequest.headers).toMatchObject({
          'webhook-id': receiver.received[0].headers['webhook-id'],
          'webhook-signature': expect.stringMatching(/^v1,/),
        });
        expect(JSON.stringify(delivery.body)).not.toContain('whsec_');

        // Paged, newest first, filtered.
        const first = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries?limit=1&count=true`)
          .expect(200);
        expect(first.body.items.map((d: { id: string }) => d.id)).toEqual([
          second.body.id,
        ]);
        expect(first.body.total).toBe(2);
        const next = await node
          .admin()
          .get(
            `${base(client.id)}/webhook-deliveries?limit=1&cursor=${first.body.nextCursor}`,
          )
          .expect(200);
        expect(next.body.items.map((d: { id: string }) => d.id)).toEqual([
          tested.body.id,
        ]);
        expect(next.body.nextCursor).toBeNull();
        const failed = await node
          .http()
          .get('/v1/webhook-deliveries?status=failed')
          .set('Authorization', client.auth)
          .expect(200);
        expect(failed.body.items).toEqual([]);
        await node
          .http()
          .get('/v1/webhook-deliveries?cursor=nope')
          .set('Authorization', client.auth)
          .expect(400);

        // Another client's log shows none of them.
        const other = await node.client();
        const theirs = await node
          .http()
          .get('/v1/webhook-deliveries')
          .set('Authorization', other.auth)
          .expect(200);
        expect(theirs.body.items).toEqual([]);
        await node
          .http()
          .get(`/v1/webhook-deliveries/${tested.body.id}`)
          .set('Authorization', other.auth)
          .expect(404);

        const tests = await node.auditEntries({
          action: 'webhook-endpoint.tested',
          targetId: client.id,
        });
        // The administrator's test is audited; the client's own isn't.
        expect(tests).toHaveLength(1);
      } finally {
        await receiver.close();
      }
    });
  });

  describe('the delivery log as a list', () => {
    it('is described at GET /v1/lists/WebhookDelivery, to an API client and to whoever manages clients', async () => {
      const client = await node.client();
      const asAdmin = await node
        .admin()
        .get('/v1/lists/WebhookDelivery')
        .expect(200);
      const asClient = await node
        .http()
        .get('/v1/lists/WebhookDelivery')
        .set('Authorization', client.auth)
        .expect(200);
      expect(asClient.body).toEqual(asAdmin.body);
      expect(asAdmin.body).toMatchObject({
        subject: 'WebhookDelivery',
        search: false,
        recycleBin: false,
        capabilities: expect.objectContaining({ events: false }),
        attachmentLimits: null,
      });
      const fields = Object.fromEntries(
        (
          asAdmin.body.fields as {
            name: string;
            type: string;
            operators: string[];
            options?: string[];
            sortable: boolean;
          }[]
        ).map((field) => [field.name, field]),
      );
      expect(fields.status).toMatchObject({
        type: 'enum',
        options: ['pending', 'succeeded', 'failed'],
      });
      expect(fields.type.operators).toEqual(['eq', 'in', 'startsWith']);
      expect(fields.type.sortable).toBe(true);
      expect(fields.attempts).toMatchObject({
        operators: ['gte', 'lte'],
        sortable: true,
      });
      expect(fields.createdAt).toMatchObject({ type: 'datetime' });
      expect(fields.endpointId).toBeDefined();
      // The client stays in the path: it is not a filter.
      expect(fields.clientId).toBeUndefined();
      expect(fields.tenant).toBeUndefined();
      expect(asAdmin.body.select).toEqual(
        expect.arrayContaining(['status', 'type', 'createdAt', 'completedAt']),
      );
      expect(asAdmin.body.limits.maxLimit).toBeGreaterThan(0);

      // A filter the metadata names is one the route takes.
      await node
        .http()
        .get(
          '/v1/webhook-deliveries?status=failed&type.startsWith=note.&attempts.gte=1&createdAt.gte=2026-01-01T00:00:00Z',
        )
        .set('Authorization', client.auth)
        .expect(200);
    });

    it('is refused to a user who may not manage clients (403) and to a guest (401)', async () => {
      const viewer = await node.user(['viewer']);
      await viewer.agent.get('/v1/lists/WebhookDelivery').expect(403);
      await node.http().get('/v1/lists/WebhookDelivery').expect(401);
    });
  });

  describe('deliveries, times and signing secrets', () => {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    it('shows every time as an ISO 8601 string, in the list, the item and the test delivery', async () => {
      const receiver = await webhookReceiver();
      try {
        const client = await node.client();
        const endpoint = await node
          .admin()
          .post(`${base(client.id)}/webhook-endpoints`)
          .send({ url: receiver.url, eventTypes: ['*'] })
          .expect(201);
        const tested = await node
          .admin()
          .post(`${base(client.id)}/webhook-endpoints/${endpoint.body.id}/test`)
          .expect(202);
        expect(tested.body.createdAt).toMatch(ISO);
        expect(tested.body.nextAttemptAt).toMatch(ISO);
        expect(tested.body.completedAt).toBeNull();

        await node.deliverWebhooks();

        const list = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries`)
          .expect(200);
        const [item] = list.body.items;
        expect(item).toMatchObject({
          id: tested.body.id,
          status: 'succeeded',
          nextAttemptAt: null,
        });
        for (const key of ['createdAt', 'lastAttemptAt', 'completedAt']) {
          expect(item[key]).toMatch(ISO);
        }
        // ?fields= still works, and the times it picks are ISO too.
        const picked = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries?fields=createdAt,status`)
          .expect(200);
        expect(Object.keys(picked.body.items[0]).sort()).toEqual([
          'createdAt',
          'id',
          'status',
        ]);
        expect(picked.body.items[0].createdAt).toMatch(ISO);
        // Filtering by an ISO time finds it, and a later one does not.
        const since = await node
          .admin()
          .get(
            `${base(client.id)}/webhook-deliveries?createdAt.gte=${item.createdAt}`,
          )
          .expect(200);
        expect(since.body.items).toHaveLength(1);
        const after = await node
          .admin()
          .get(
            `${base(client.id)}/webhook-deliveries?createdAt.gt=${item.createdAt}`,
          )
          .expect(200);
        expect(after.body.items).toEqual([]);

        const one = await node
          .http()
          .get(`/v1/webhook-deliveries/${tested.body.id}`)
          .set('Authorization', client.auth)
          .expect(200);
        expect(one.body.createdAt).toMatch(ISO);
        expect(one.body.message.createdAt).toMatch(ISO);
        expect(one.body.history).toHaveLength(1);
        expect(one.body.history[0].at).toMatch(ISO);
        expect(one.body.lastRequest.sentAt).toMatch(ISO);
        expect(new Date(one.body.createdAt).getTime()).toBeLessThanOrEqual(
          new Date(one.body.lastRequest.sentAt).getTime() + 1000,
        );
      } finally {
        await receiver.close();
      }
    });

    it('records which secrets signed each attempt, both during the overlap after a rotation, never the secrets', async () => {
      const receiver = await webhookReceiver();
      try {
        const client = await node.client();
        const created = await node
          .admin()
          .post(`${base(client.id)}/webhook-endpoints`)
          .send({ url: receiver.url, eventTypes: ['*'] })
          .expect(201);
        const endpoint = `${base(client.id)}/webhook-endpoints/${created.body.id}`;
        const secrets: string[] = [created.body.secret];

        const before = await node.admin().post(`${endpoint}/test`).expect(202);
        await node.deliverWebhooks();
        const first = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries/${before.body.id}`)
          .expect(200);
        expect(first.body.lastRequest.signedWith).toEqual([
          { createdAt: expect.stringMatching(ISO), expiresAt: null },
        ]);
        const originalSecret = first.body.lastRequest.signedWith[0];
        expect(
          first.body.lastRequest.headers['webhook-signature'].split(' '),
        ).toHaveLength(1);

        const rotated = await node
          .admin()
          .post(`${endpoint}/rotate-secret`)
          .expect(200);
        secrets.push(rotated.body.secret);

        const during = await node.admin().post(`${endpoint}/test`).expect(202);
        await node.deliverWebhooks();
        const second = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries/${during.body.id}`)
          .expect(200);
        const { signedWith } = second.body.lastRequest;
        // Newest first, as the v1,… signatures are; the old one ends in 24 hours.
        expect(signedWith).toHaveLength(2);
        expect(
          second.body.lastRequest.headers['webhook-signature'].split(' '),
        ).toHaveLength(2);
        expect(signedWith[1]).toEqual({
          createdAt: originalSecret.createdAt,
          expiresAt: expect.stringMatching(ISO),
        });
        expect(signedWith[0].expiresAt).toBeNull();
        expect(
          new Date(signedWith[0].createdAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date(signedWith[1].createdAt).getTime());
        const overlapEnd =
          new Date(signedWith[1].expiresAt).getTime() - Date.now();
        expect(overlapEnd).toBeGreaterThan(23 * 3600_000);
        expect(overlapEnd).toBeLessThanOrEqual(24 * 3600_000);

        // The same through the client's own door, and no secret material anywhere.
        const own = await node
          .http()
          .get(`/v1/webhook-deliveries/${during.body.id}`)
          .set('Authorization', client.auth)
          .expect(200);
        expect(own.body.lastRequest.signedWith).toEqual(signedWith);
        const raw = JSON.stringify([first.body, second.body, own.body]);
        expect(raw).not.toContain('whsec_');
        for (const secret of secrets) {
          expect(raw).not.toContain(secret);
          expect(raw).not.toContain(secret.slice('whsec_'.length));
        }
        // The list items carry no signing detail.
        const list = await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries`)
          .expect(200);
        expect(JSON.stringify(list.body)).not.toContain('signedWith');
      } finally {
        await receiver.close();
      }
    });
  });

  describe('endpoint counts on API clients', () => {
    it("counts each client's endpoints, 0 and 2, in the list and on one client", async () => {
      const [empty, busy] = [await node.client(), await node.client()];
      for (const path of ['one', 'two']) {
        await node
          .admin()
          .post(`${base(busy.id)}/webhook-endpoints`)
          .send({
            url: `https://hooks.example.com/${path}`,
            eventTypes: ['*'],
          })
          .expect(201);
      }
      const list = await node.admin().get('/v1/access/clients').expect(200);
      const count = (id: string) =>
        list.body.items.find((c: { id: string }) => c.id === id)
          .webhookEndpoints;
      expect(count(empty.id)).toBe(0);
      expect(count(busy.id)).toBe(2);

      const one = await node.admin().get(`/v1/access/clients/${busy.id}`);
      expect(one.body.webhookEndpoints).toBe(2);

      // Deleting one lowers it.
      const endpoints = await node
        .admin()
        .get(`${base(busy.id)}/webhook-endpoints`)
        .expect(200);
      await node
        .admin()
        .delete(
          `${base(busy.id)}/webhook-endpoints/${endpoints.body.items[0].id}`,
        )
        .expect(204);
      const again = await node.admin().get(`/v1/access/clients/${busy.id}`);
      expect(again.body.webhookEndpoints).toBe(1);
    });
  });
});
