import { randomBytes, randomUUID } from 'node:crypto';
import { signWebhook } from '@nestjs/webhooks/testing';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireTenantId } from '../src/core/tenancy/tenant-scope.js';
import { IncomingEventHandlers } from '../src/platform/webhooks/incoming-event-handlers.js';
import { incomingWebhookSenders } from '../src/platform/webhooks/incoming-senders.tables.js';
import { bootApp, type TestApp } from './support.js';

/**
 * A tenant's own senders of incoming webhooks (`/v1/webhook-senders`,
 * `POST /v1/webhooks/tenants/{tenantId}/senders/{name}`): the receiver knows
 * the tenant of the work from the URL, and a call is verified with that
 * tenant's sender's secret alone (docs/webhooks-and-realtime.md).
 */
describe('incoming webhook senders of a tenant (e2e)', () => {
  let node: TestApp;
  let other: Awaited<ReturnType<TestApp['otherTenant']>>;
  /** What the handler of `test.echo` saw, in order. */
  let seen: { tenantId: string; scope: string; sender: string; id: string }[];

  // Secrets sealed at rest, as a deployment with WEBHOOKS_ENCRYPTION_KEYS has them.
  beforeAll(() => {
    process.env.WEBHOOKS_ENCRYPTION_KEYS = randomBytes(32).toString('base64');
  });
  afterAll(() => {
    delete process.env.WEBHOOKS_ENCRYPTION_KEYS;
  });

  beforeEach(async () => {
    node = await bootApp();
    other = await node.otherTenant();
    seen = [];
    node.app.get(IncomingEventHandlers).register(
      'test.echo',
      {
        description: 'Echo.',
        dataSchema: z.object({ n: z.number() }),
        example: { n: 1 },
        delivery: 'Deduplicated by the webhook-id.',
      },
      async (ctx) => {
        seen.push({
          tenantId: ctx.tenantId,
          // The tenant the work really runs in: the request's scope.
          scope: requireTenantId(),
          sender: ctx.sender,
          id: ctx.webhook.id,
        });
        return { duplicate: false };
      },
    );
  });
  afterEach(() => node.close());

  /** A sender of the seeded tenant, made by its administrator. */
  async function create(name = 'crm') {
    const res = await node.admin().post('/v1/webhook-senders').send({ name });
    expect(res.status).toBe(201);
    return res.body as {
      id: string;
      secret: string;
      path: string;
      name: string;
    };
  }

  /** A call to `path`, signed with `secret`. */
  function call(
    path: string,
    secret: string,
    {
      id = `msg_${randomUUID()}`,
      payload = { type: 'test.echo', data: { n: 1 } } as unknown,
      timestamp,
    }: { id?: string; payload?: unknown; timestamp?: Date } = {},
  ) {
    const signed = signWebhook({
      scheme: 'standard',
      secret,
      payload,
      id,
      timestamp,
    });
    return node.http().post(path).set(signed.headers).send(signed.body);
  }

  it('verifies a call with the sender’s secret and runs it in the sender’s tenant', async () => {
    const sender = await create();
    expect(sender.secret).toMatch(/^whsec_/);
    expect(sender.path).toBe(
      `/v1/webhooks/tenants/${node.tenantId}/senders/crm`,
    );

    const id = `msg_${randomUUID()}`;
    const first = await call(sender.path, sender.secret, { id }).expect(200);
    expect(first.body).toEqual({
      received: true,
      duplicate: false,
      handled: true,
    });
    expect(seen).toEqual([
      {
        tenantId: node.tenantId,
        scope: node.tenantId,
        sender: 'crm',
        id: `${sender.id}:${id}`,
      },
    ]);

    // The sender's retry of the same event id: answered without running the handler.
    await call(sender.path, sender.secret, { id }).expect(200);
    expect(seen).toHaveLength(1);

    // An event nobody handles is acknowledged, not retried.
    const ignored = await call(sender.path, sender.secret, {
      payload: { type: 'nobody.handles', data: {} },
    }).expect(200);
    expect(ignored.body).toMatchObject({ received: true, handled: false });
    // A `data` that does not match the type's schema is a 400, before the handler.
    const invalid = await call(sender.path, sender.secret, {
      payload: { type: 'test.echo', data: { n: 'x' } },
    }).expect(400);
    expect(invalid.body.errors[0].path).toBe('data.n');
    expect(seen).toHaveLength(1);
    // A body that is not an event is a 400, signed or not.
    await call(sender.path, sender.secret, { payload: { data: 1 } }).expect(
      400,
    );
  });

  it('refuses another tenant’s secret, and a sender under another tenant’s URL', async () => {
    const mine = await create();
    // The other tenant registers a sender of the same name.
    const theirs = (
      await other.admin
        .post('/v1/webhook-senders')
        .send({ name: 'crm' })
        .expect(201)
    ).body as { id: string; secret: string; path: string };
    expect(theirs.path).toBe(`/v1/webhooks/tenants/${other.id}/senders/crm`);
    expect(theirs.secret).not.toBe(mine.secret);

    // Each secret works on its own tenant's URL only.
    await call(mine.path, theirs.secret).expect(401);
    await call(theirs.path, mine.secret).expect(401);
    // Naming one tenant's sender under the other's id finds nothing: row-level security.
    await call(
      `/v1/webhooks/tenants/${other.id}/senders/crm`,
      mine.secret,
    ).expect(401);
    await call(
      `/v1/webhooks/tenants/${node.tenantId}/senders/crm`,
      theirs.secret,
    ).expect(401);
    expect(seen).toEqual([]);

    // A sender only the other tenant has, asked for under ours; unknown tenants and names.
    const only = (
      await other.admin
        .post('/v1/webhook-senders')
        .send({ name: 'only-theirs' })
        .expect(201)
    ).body as { secret: string };
    await call(
      `/v1/webhooks/tenants/${node.tenantId}/senders/only-theirs`,
      only.secret,
    ).expect(401);
    await call(
      `/v1/webhooks/tenants/${randomUUID()}/senders/crm`,
      mine.secret,
    ).expect(401);
    await call(
      `/v1/webhooks/tenants/not-a-uuid/senders/crm`,
      mine.secret,
    ).expect(401);
    await call(
      `/v1/webhooks/tenants/${node.tenantId}/senders/nope`,
      mine.secret,
    ).expect(401);

    // Each works where it belongs, in its own tenant.
    await call(mine.path, mine.secret).expect(200);
    await call(theirs.path, theirs.secret).expect(200);
    expect(seen.map((s) => [s.tenantId, s.scope])).toEqual([
      [node.tenantId, node.tenantId],
      [other.id, other.id],
    ]);
  });

  it('refuses a bad, tampered or stale signature, and no signature', async () => {
    const sender = await create();
    await call(
      sender.path,
      `whsec_${Buffer.from(randomUUID()).toString('base64')}`,
    ).expect(401);
    await call(sender.path, sender.secret, {
      timestamp: new Date(Date.now() - 60 * 60 * 1000),
    }).expect(401);
    const signed = signWebhook({
      scheme: 'standard',
      secret: sender.secret,
      payload: { type: 'test.echo', data: { n: 1 } },
    });
    await node
      .http()
      .post(sender.path)
      .set(signed.headers)
      .send(signed.body.replace('"n":1', '"n":2'))
      .expect(401);
    await node
      .http()
      .post(sender.path)
      .send({ type: 'test.echo', data: {} })
      .expect(401);
    expect(seen).toEqual([]);
  });

  it('gives two senders of two tenants the same webhook id without one blocking the other', async () => {
    const mine = await create();
    const theirs = (
      await other.admin
        .post('/v1/webhook-senders')
        .send({ name: 'crm' })
        .expect(201)
    ).body as { secret: string; path: string };
    const id = `msg_${randomUUID()}`;
    await call(mine.path, mine.secret, { id }).expect(200);
    await call(theirs.path, theirs.secret, { id }).expect(200);
    expect(seen).toHaveLength(2);
  });

  it('stops a disabled or removed sender, and keeps the old secret only for the grace period', async () => {
    const sender = await create();
    const admin = node.admin();

    await admin
      .patch(`/v1/webhook-senders/${sender.id}`)
      .send({ enabled: false })
      .expect(200);
    await call(sender.path, sender.secret).expect(401);
    await admin
      .patch(`/v1/webhook-senders/${sender.id}`)
      .send({ enabled: true, description: 'The CRM' })
      .expect(200);
    await call(sender.path, sender.secret).expect(200);

    const rotated = (
      await admin
        .post(`/v1/webhook-senders/${sender.id}/rotate-secret`)
        .send({})
        .expect(200)
    ).body as { secret: string; previousSecretExpiresAt: string };
    expect(rotated.secret).not.toBe(sender.secret);
    expect(new Date(rotated.previousSecretExpiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    await call(sender.path, rotated.secret).expect(200);
    await call(sender.path, sender.secret).expect(200); // within the grace period

    const ended = (
      await admin
        .post(`/v1/webhook-senders/${sender.id}/rotate-secret`)
        .send({ graceSeconds: 0 })
        .expect(200)
    ).body as { secret: string; previousSecretExpiresAt: string | null };
    expect(ended.previousSecretExpiresAt).toBeNull();
    await call(sender.path, rotated.secret).expect(401);
    await call(sender.path, ended.secret).expect(200);

    await admin.delete(`/v1/webhook-senders/${sender.id}`).expect(204);
    await call(sender.path, ended.secret).expect(401);
    await admin.delete(`/v1/webhook-senders/${sender.id}`).expect(404);
  });

  it('refuses a call for a deactivated tenant', async () => {
    const theirs = (
      await other.admin
        .post('/v1/webhook-senders')
        .send({ name: 'crm' })
        .expect(201)
    ).body as { secret: string; path: string };
    await call(theirs.path, theirs.secret).expect(200);
    await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .send({ active: false })
      .expect(200);
    await call(theirs.path, theirs.secret).expect(401);
  });

  it('manages senders per tenant, for administrators only, and never shows or audits a secret', async () => {
    const sender = await create();
    await create('billing');
    await other.admin
      .post('/v1/webhook-senders')
      .send({ name: 'crm' })
      .expect(201);

    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/webhook-senders').expect(403);
    await editor.agent
      .post('/v1/webhook-senders')
      .send({ name: 'x' })
      .expect(403);
    await node.http().get('/v1/webhook-senders').expect(401);
    const client = await node.client();
    await node
      .http()
      .get('/v1/webhook-senders')
      .set('Authorization', client.auth)
      .expect(401);

    // Only this tenant's senders, by name.
    const list = await node.admin().get('/v1/webhook-senders').expect(200);
    expect(list.body.items.map((s: { name: string }) => s.name)).toEqual([
      'billing',
      'crm',
    ]);
    // Another tenant's sender is a 404 here.
    const theirs = await other.admin.get('/v1/webhook-senders').expect(200);
    await node
      .admin()
      .get(`/v1/webhook-senders/${theirs.body.items[0].id}`)
      .expect(404);
    await node
      .admin()
      .patch(`/v1/webhook-senders/${theirs.body.items[0].id}`)
      .send({ enabled: false })
      .expect(404);

    await node
      .admin()
      .post('/v1/webhook-senders')
      .send({ name: 'crm' })
      .expect(409);
    await node
      .admin()
      .post('/v1/webhook-senders')
      .send({ name: 'Not A Name' })
      .expect(400);

    // No secret after the one answer.
    const one = await node
      .admin()
      .get(`/v1/webhook-senders/${sender.id}`)
      .expect(200);
    expect(JSON.stringify([list.body, one.body])).not.toContain(sender.secret);
    expect(one.body).not.toHaveProperty('secret');

    await node
      .admin()
      .post(`/v1/webhook-senders/${sender.id}/rotate-secret`)
      .send({})
      .expect(200);
    const audit = await node
      .admin()
      .get(`/v1/access/audit?targetId=${sender.id}`)
      .expect(200);
    expect(
      audit.body.items.map((entry: { action: string }) => entry.action).sort(),
    ).toEqual(['webhookSender.created', 'webhookSender.secret-rotated']);
    expect(JSON.stringify(audit.body)).not.toContain('whsec_');
  });

  it('lists the incoming event types, generated from the handlers, for administrators only', async () => {
    const catalog = await node
      .admin()
      .get('/v1/webhook-incoming-event-types')
      .expect(200);
    // Features add their own types (notes: test/features/notes): only the fixture's is certain.
    const items = catalog.body.items as {
      type: string;
      dataSchema: unknown;
      example: { type: string };
    }[];
    const types = items.map((i) => i.type);
    expect(types).toContain('test.echo');
    expect(types).toEqual(types.toSorted((a, b) => a.localeCompare(b)));
    for (const item of items) {
      expect(item.dataSchema).toMatchObject({ type: 'object' });
      expect(item.example.type).toBe(item.type);
    }
    // Not the outgoing catalog.
    const outgoing = await node.admin().get('/v1/webhook-event-types');
    expect(JSON.stringify(outgoing.body)).not.toContain('test.echo');

    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/webhook-incoming-event-types').expect(403);
    await node.http().get('/v1/webhook-incoming-event-types').expect(401);
    const client = await node.client();
    await node
      .http()
      .get('/v1/webhook-incoming-event-types')
      .set('Authorization', client.auth)
      .expect(401);
  });

  it('stores the secret sealed, bound to its sender', async () => {
    const sender = await create();
    const [row] = await node.inTenant(() =>
      node.db
        .select()
        .from(incomingWebhookSenders)
        .where(eq(incomingWebhookSenders.id, sender.id)),
    );
    expect(row!.secret.startsWith('sealed.v1.')).toBe(true);
    expect(row!.secret).not.toContain(sender.secret);
  });
});
