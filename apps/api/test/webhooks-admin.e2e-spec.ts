import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { WebhookDeliveryRetentionJob } from '../src/platform/webhooks/webhook-delivery-retention.job.js';
import { storeDeliveries } from '../src/platform/webhooks/webhook-store.view.js';
import { webhookDeliveryRequests } from '../src/platform/webhooks/webhooks.tables.js';
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

  describe('retention', () => {
    const DAY = 86_400_000;

    it('prunes finished deliveries past WEBHOOKS_DELIVERY_RETENTION_DAYS with their recorded requests, and keeps recent and pending ones', async () => {
      const receiver = await webhookReceiver();
      try {
        const client = await node.client();
        const endpoint = await node
          .admin()
          .post(`${base(client.id)}/webhook-endpoints`)
          .send({ url: receiver.url, eventTypes: ['approval.requested'] })
          .expect(201);
        const send = async () =>
          (
            await node
              .admin()
              .post(
                `${base(client.id)}/webhook-endpoints/${endpoint.body.id}/test`,
              )
              .expect(202)
          ).body.id as string;

        // Two sent (their request headers recorded), then three left waiting.
        const old = await send();
        const recent = await send();
        await node.deliverWebhooks();
        expect(receiver.received).toHaveLength(2);
        const [oldFailed, retrying, oldRetrying] = [
          await send(),
          await send(),
          await send(),
        ];

        const now = Date.now();
        const finish = (id: string, status: string, completedAt: number) =>
          node.db
            .update(storeDeliveries)
            .set({ status, completedAt })
            .where(eq(storeDeliveries.id, id));
        await finish(old, 'succeeded', now - 31 * DAY);
        await finish(recent, 'succeeded', now - 29 * DAY);
        await finish(oldFailed, 'failed', now - 40 * DAY);
        // Still being retried, however long ago it was created.
        await node.db
          .update(storeDeliveries)
          .set({ createdAt: now - 60 * DAY })
          .where(inArray(storeDeliveries.id, [retrying, oldRetrying]));
        // A failed delivery has been sent; so has a retrying one (and one whose delivery is gone).
        const orphan = `dlv_${randomUUID().replaceAll('-', '')}`;
        await node.db.insert(webhookDeliveryRequests).values(
          [oldFailed, retrying, orphan].map((deliveryId) => ({
            deliveryId,
            attempt: 1,
            headers: { 'webhook-id': 'msg_1' },
          })),
        );
        const requests = async () =>
          (
            await node.db
              .select({ id: webhookDeliveryRequests.deliveryId })
              .from(webhookDeliveryRequests)
              .where(
                inArray(webhookDeliveryRequests.deliveryId, [
                  old,
                  recent,
                  oldFailed,
                  retrying,
                  oldRetrying,
                  orphan,
                ]),
              )
          )
            .map((row) => row.id)
            .sort();
        expect(await requests()).toEqual(
          [old, recent, oldFailed, retrying, orphan].sort(),
        );

        // Older than 30 days and finished: the succeeded and the failed one.
        const result = await node.app.get(WebhookDeliveryRetentionJob).run();
        expect(result.deliveries).toBe(2);
        expect(result.requests).toBeGreaterThanOrEqual(3);
        const kept = await node.db
          .select({ id: storeDeliveries.id })
          .from(storeDeliveries)
          .where(
            inArray(storeDeliveries.id, [
              old,
              recent,
              oldFailed,
              retrying,
              oldRetrying,
            ]),
          );
        expect(kept.map((row) => row.id).sort()).toEqual(
          [recent, retrying, oldRetrying].sort(),
        );
        // Their recorded requests went with them (and the orphan's); the others stay.
        expect(await requests()).toEqual([recent, retrying].sort());
        await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries/${old}`)
          .expect(404);
        await node
          .admin()
          .get(`${base(client.id)}/webhook-deliveries/${recent}`)
          .expect(200);

        // Nothing more is old enough: a second run deletes nothing.
        expect(await node.app.get(WebhookDeliveryRetentionJob).run()).toEqual({
          deliveries: 0,
          requests: 0,
        });
      } finally {
        await receiver.close();
      }
    });

    it('is declared in the catalog, with no permissions', async () => {
      const catalog = await node.admin().get('/v1/access/catalog').expect(200);
      const jobs = catalog.body.systemJobs as {
        key: string;
        permissions: unknown[];
      }[];
      expect(
        jobs.find((job) => job.key === 'webhook-delivery-retention'),
      ).toMatchObject({ permissions: [] });
    });
  });
});
