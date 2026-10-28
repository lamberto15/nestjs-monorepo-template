import type { NotificationType } from '../src/platform/notifications/notification.types.js';
import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OutboxRelay } from '@nestjs/outbox';
import { eq, sql } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import type request from 'supertest';
import { inTransaction } from '../src/core/database/transactions.js';
import { NotificationDigestJob } from '../src/platform/notifications/notification-digest.job.js';
import { NotificationRetentionJob } from '../src/platform/notifications/notification-retention.job.js';
import { notifications } from '../src/platform/notifications/notifications.tables.js';
import {
  NotificationsService,
  type NotifyInput,
  READ_ALL_BATCH,
  UNREAD_COUNT_CAP,
} from '../src/platform/notifications/notifications.service.js';
import { bootApp, connect, type TestApp, webhookReceiver } from './support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('notifications (e2e)', () => {
  let node: TestApp;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await node.close();
  });

  const db = () => node.db;
  /** Hands committed outbox messages to the delivery handler (the worker's job). */
  const deliver = () => node.app.get(OutboxRelay).runOnce();
  /** The `errors` paths of a problem response. */
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);

  /**
   * A test item of `auth`'s, commented on by the administrator: its owner
   * watches it, so they are told (`testItem.commented`).
   */
  async function commented(auth: string | request.Agent) {
    const item = (
      await node.writeItem(auth, { title: 'Hello', body: '' }).expect(201)
    ).body as { id: string };
    await node
      .admin()
      .post(`/v1/test-items/${item.id}/comments`)
      .send({ body: 'Looks good.' })
      .expect(201);
    return item;
  }

  /** The `data` of a `testItem.commented` notification. */
  const commentData = (title: string) => ({
    recordId: randomUUID(),
    commentId: randomUUID(),
    title,
    by: 'Ada',
    excerpt: 'Looks good.',
  });

  /** A notification sent straight from code, as a feature's service does. */
  async function notify(to: string, input: Partial<NotifyInput> = {}) {
    const service = node.app.get(NotificationsService);
    const txHost = node.app.get(TransactionHost);
    // In the seeded tenant, as a feature notifies from a request or a job.
    const [id] = await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        service.notify(tx, {
          // The test-only feature's type: not among the app's catalog keys.
          type: 'testItem.commented' as NotificationType,
          to,
          data: commentData('Direct'),
          ...input,
        }),
      ),
    );
    return id!;
  }

  const row = async (id: string) =>
    (
      await db().select().from(notifications).where(eq(notifications.id, id))
    )[0]!;

  it('counts and lists the tenant and account notifications while excluding another tenant', async () => {
    const editor = await node.user(['editor']);
    const other = await node.otherTenant();
    const recipient = `user:${editor.id}`;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    // The owner connection seeds all three scopes; the HTTP reads use RLS.
    await db()
      .insert(notifications)
      .values(
        [node.tenantId, null, other.id].map((tenantId, index) => ({
          id: ids[index]!,
          tenantId,
          recipient,
          type: 'testItem.commented',
          data: commentData('Tenant visibility'),
        })),
      );
    const unread = await editor.agent
      .get('/v1/notifications/unread-count')
      .expect(200);
    expect(unread.body).toEqual({ unread: 2, unreadCapped: false });
    const page = await editor.agent
      .get('/v1/notifications?count=true')
      .expect(200);
    expect(page.body.total).toBe(2);
    expect(
      page.body.items
        .map((item: { id: string }) => item.id)
        .sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(ids.slice(0, 2).sort((a, b) => a.localeCompare(b)));
  });

  it('marks all read in batches', async () => {
    const editor = await node.user(['editor']);
    const recipient = `user:${editor.id}`;
    const total = READ_ALL_BATCH * 2 + 3;
    for (let done = 0; done < total; done += 2_000) {
      await db()
        .insert(notifications)
        .values(
          Array.from({ length: Math.min(2_000, total - done) }, () => ({
            tenantId: node.tenantId,
            recipient,
            type: 'testItem.commented',
            data: commentData('Batch'),
          })),
        );
    }
    const res = await editor.agent
      .post('/v1/notifications/read-all')
      .send({})
      .expect(200);
    expect(res.body).toEqual({ updated: total });
    const count = await editor.agent
      .get('/v1/notifications/unread-count')
      .expect(200);
    expect(count.body.unread).toBe(0);
  });

  it('caps the unread count and delivers without an ordering key', async () => {
    const editor = await node.user(['editor']);
    const recipient = `user:${editor.id}`;
    await db()
      .insert(notifications)
      .values(
        Array.from({ length: UNREAD_COUNT_CAP + 1 }, () => ({
          tenantId: node.tenantId,
          recipient,
          type: 'testItem.commented',
          data: commentData('Backlog'),
        })),
      );
    const capped = await editor.agent
      .get('/v1/notifications/unread-count')
      .expect(200);
    expect(capped.body).toEqual({
      unread: UNREAD_COUNT_CAP,
      unreadCapped: true,
    });

    const id = await notify(recipient);
    const [message] = await db()
      .select({ key: sql<string | null>`key` })
      .from(sql`nest_outbox.messages`)
      .where(
        sql`topic = 'notifications.deliver' and payload->>'notificationId' = ${id}`,
      );
    expect(message).toEqual({ key: null });
  });

  /** The mail a user got but their invitation: what notifications sent them. */
  const noticesTo = (email: string) =>
    node.mailbox
      .filter({ to: email })
      .filter((mail) => !/invited you to/.test(mail.message.subject));

  /** A user's address, for the mailbox. */
  const emailOf = async (agent: request.Agent) =>
    (await agent.get('/v1/auth/me').expect(200)).body.user.email as string;

  it('tells a user in-app, in their language, and by mail; they read and mark it', async () => {
    const editor = await node.user(['editor']);
    await editor.agent
      .patch('/v1/auth/me')
      .send({ locale: 'de', timezone: 'Europe/Berlin' })
      .expect(200);
    const email = await emailOf(editor.agent);
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'immediate' } })
      .expect(200);
    const record = await commented(editor.agent);
    await deliver();

    const page = await editor.agent.get('/v1/notifications').expect(200);
    expect(page.body.items).toHaveLength(1);
    const item = page.body.items[0];
    expect(item).toMatchObject({
      type: 'testItem.commented',
      title: 'Neuer Kommentar',
      body: 'Administrator hat „Hello“ kommentiert: Looks good.',
      data: {
        recordId: record.id,
        title: 'Hello',
        by: 'Administrator',
        excerpt: 'Looks good.',
      },
      link: `/test-items/${record.id}`,
      key: `testItem.commented:${record.id}`,
      count: 1,
      read: false,
      readAt: null,
    });
    // The texts follow the request's language, not the stored one.
    const english = await editor.agent
      .get('/v1/notifications?lang=en')
      .expect(200);
    expect(english.body.items[0].title).toBe('New comment');
    expect(english.body.items[0].body).toBe(
      'Administrator commented on "Hello": Looks good.',
    );
    expect(
      (await editor.agent.get('/v1/notifications/unread-count').expect(200))
        .body,
    ).toEqual({ unread: 1, unreadCapped: false });

    // The mail, in German, with the link into the web app.
    const mail = await node.waitForMail({
      to: email,
      subject: /Neuer Kommentar/,
    });
    expect(mail.html).toContain('hat „Hello“ kommentiert');
    expect(mail.html).toContain(
      `https://web.example.com/test-items/${record.id}`,
    );

    // Read: once, and again without change; nobody else can.
    const read = await editor.agent
      .post(`/v1/notifications/${item.id}/read`)
      .expect(200);
    expect(read.body.read).toBe(true);
    expect(read.body.readAt).toBeTruthy();
    expect(
      (await editor.agent.post(`/v1/notifications/${item.id}/read`).expect(200))
        .body.readAt,
    ).toBe(read.body.readAt);
    expect(
      (await editor.agent.get('/v1/notifications/unread-count').expect(200))
        .body,
    ).toEqual({ unread: 0, unreadCapped: false });
    const other = await node.user(['editor']);
    await other.agent.post(`/v1/notifications/${item.id}/read`).expect(404);
    await other.agent.delete(`/v1/notifications/${item.id}`).expect(404);
    expect(
      (await other.agent.get('/v1/notifications').expect(200)).body.items,
    ).toEqual([]);
    await editor.agent.delete(`/v1/notifications/${item.id}`).expect(204);
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toEqual([]);
  });

  it('essential-only suppresses ordinary notification mail but keeps inbox delivery', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    await node
      .admin()
      .put('/v1/settings/mail.delivery/platform')
      .send({ value: 'essential' })
      .expect(200);
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'immediate' } })
      .expect(200);
    const id = await notify(`user:${editor.id}`);
    await deliver();

    expect((await row(id)).deliveredAt).toBeTruthy();
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toHaveLength(1);
    expect(noticesTo(email)).toEqual([]);

    const mandatory = await notify(`user:${editor.id}`, {
      type: 'security.passwordChanged' as NotificationType,
      data: { via: 'change', ip: '192.0.2.10' },
      key: randomUUID(),
    });
    await deliver();
    expect((await row(mandatory)).deliveredAt).toBeTruthy();
    await node.waitForMail({ to: email, subject: /password/i });
  });

  it('the daily budgets, the deployment’s and the tenant’s, withhold notification mail but not inbox delivery or essential mail', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'immediate' } })
      .expect(200);
    const mailed = async () => {
      const id = await notify(`user:${editor.id}`);
      await deliver();
      expect((await row(id)).deliveredAt).toBeTruthy();
    };

    // The deployment's: 0 leaves only essential mail.
    await node
      .admin()
      .put('/v1/settings/mail.dailyLimit/platform')
      .send({ value: 0 })
      .expect(200);
    await mailed();
    await node
      .admin()
      .delete('/v1/settings/mail.dailyLimit/platform')
      .expect(204);
    // The tenant's quota, while the deployment's has no limit.
    await node
      .admin()
      .put(`/v1/tenants/${node.tenantId}/quotas`)
      .send({ maxMailsPerDay: 0 })
      .expect(200);
    await mailed();
    const usage = (
      await node.admin().get(`/v1/tenants/${node.tenantId}/usage`).expect(200)
    ).body;
    expect(usage.mailsPerDay).toMatchObject({ limit: 0 });
    expect(usage.limits).toMatchObject({ maxMailsPerDay: 0 });

    // Essential mail still goes, and the notices never went.
    const mandatory = await notify(`user:${editor.id}`, {
      type: 'security.passwordChanged' as NotificationType,
      data: { via: 'change', ip: '192.0.2.10' },
      key: randomUUID(),
    });
    await deliver();
    expect((await row(mandatory)).deliveredAt).toBeTruthy();
    await node.waitForMail({ to: email, subject: /password/i });
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toHaveLength(3);
    expect(
      noticesTo(email).filter(
        (mail) => !/password/i.test(mail.message.subject),
      ),
    ).toEqual([]);
  });

  it('tells an API client live and by webhook, which it may switch off', async () => {
    const receiver = await webhookReceiver();
    try {
      const client = await node.client();
      await node
        .http()
        .post('/v1/webhook-endpoints')
        .set('Authorization', client.auth)
        .send({ url: receiver.url, eventTypes: ['notification.created'] })
        .expect(201);
      const socket = await connect(node, client.key);
      sockets.push(socket);
      const live = new Promise<{ id: string; title: string }>((resolve) =>
        socket.once('notification', resolve),
      );
      const liveCount = new Promise<{ unread: number; unreadCapped: boolean }>(
        (resolve) => socket.once('notifications.unread-count', resolve),
      );

      const item = await commented(client.auth);
      await deliver(); // the handler: it dispatches the webhook through the outbox
      await node.deliverWebhooks();

      expect(receiver.received.map((w) => w.body.type)).toEqual([
        'notification.created',
      ]);
      expect(receiver.received[0]!.body.data).toMatchObject({
        type: 'testItem.commented',
        title: 'New comment',
        data: { recordId: item.id, title: 'Hello' },
        count: 1,
      });
      const live_ = await live;
      expect(live_.title).toBe('New comment');
      const list = await node
        .http()
        .get('/v1/notifications')
        .set('Authorization', client.auth)
        .expect(200);
      expect(list.body.items[0].id).toBe(live_.id);

      // Every connection keeps up: the count after the delivery, each change.
      const next = <T>(event: string) =>
        new Promise<T>((resolve) => socket.once(event, resolve));
      expect(await liveCount).toEqual({ unread: 1, unreadCapped: false });
      const [read, afterRead] = await Promise.all([
        next<{ id: string; readAt: string }>('notification.read'),
        next<{ unread: number; unreadCapped: boolean }>(
          'notifications.unread-count',
        ),
        node
          .http()
          .post(`/v1/notifications/${live_.id}/read`)
          .set('Authorization', client.auth)
          .expect(200),
      ]);
      expect(read.id).toBe(live_.id);
      expect(read.readAt).toBeTruthy();
      expect(afterRead).toEqual({ unread: 0, unreadCapped: false });
      const [removed] = await Promise.all([
        next<{ id: string }>('notification.removed'),
        node
          .http()
          .delete(`/v1/notifications/${live_.id}`)
          .set('Authorization', client.auth)
          .expect(204),
      ]);
      expect(removed).toEqual({ id: live_.id });
      // No mail for a system.
      expect(node.mailbox.find({ subject: /New comment/ })).toBeUndefined();

      // Its choices: the webhook only; a client has no email to set.
      const types = await node
        .http()
        .get('/v1/notifications/types')
        .set('Authorization', client.auth)
        .expect(200);
      expect(
        types.body.items.find(
          (t: { type: string }) => t.type === 'testItem.commented',
        ),
      ).toEqual({
        type: 'testItem.commented',
        label: 'Comment on a test item you watch',
        mandatory: false,
        urgent: false,
        channels: { webhook: true },
      });
      const refused = await node
        .http()
        .put('/v1/notifications/preferences')
        .set('Authorization', client.auth)
        .send({ 'testItem.commented': { email: false } })
        .expect(400);
      expect(paths(refused.body)).toEqual(['testItem.commented.email']);
      const off = await node
        .http()
        .put('/v1/notifications/preferences')
        .set('Authorization', client.auth)
        .send({ 'testItem.commented': { webhook: false } })
        .expect(200);
      expect(off.body.types['testItem.commented']).toEqual({ webhook: false });
      await commented(client.auth);
      await deliver();
      await node.deliverWebhooks();
      expect(receiver.received).toHaveLength(1);
    } finally {
      await receiver.close();
    }
  });

  it('lets a user opt out of mail per type, except a mandatory one; audited', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    expect(
      (await editor.agent.get('/v1/notifications/preferences').expect(200))
        .body,
    ).toMatchObject({
      types: expect.objectContaining({
        'testItem.commented': { email: 'daily' },
        'comment.mentioned': { email: 'immediate' },
        'approval.requested': { email: 'immediate' },
        'security.newSignIn': { email: 'immediate' },
        'security.passwordChanged': { email: 'immediate' },
        'security.apiKeyRotated': { email: false },
      }),
    });
    const changed = await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: false } })
      .expect(200);
    expect(changed.body.types['testItem.commented']).toEqual({ email: false });

    await commented(editor.agent);
    await deliver();
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toHaveLength(1);
    expect(noticesTo(email)).toEqual([]);

    // Invalid settings, each named.
    const invalid = async (body: object, path: string) => {
      const response = await editor.agent
        .put('/v1/notifications/preferences')
        .send(body)
        .expect(400);
      expect(response.body.code).toBe('validation_failed');
      expect(paths(response.body)).toEqual([path]);
    };
    await invalid(
      { 'security.passwordChanged': { email: false } },
      'security.passwordChanged.email',
    );
    await invalid({ 'testItem.nope': { email: false } }, 'testItem.nope');
    await invalid(
      { 'testItem.commented': { sms: true } },
      'testItem.commented.sms',
    );
    await invalid(
      { 'testItem.commented': { email: 'often' } },
      'testItem.commented.email',
    );
    // A mandatory type may change its frequency.
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'security.passwordChanged': { email: 'daily' } })
      .expect(200);
    const types = await editor.agent.get('/v1/notifications/types').expect(200);
    expect(
      types.body.items.find(
        (t: { type: string }) => t.type === 'security.passwordChanged',
      ),
    ).toMatchObject({
      type: 'security.passwordChanged',
      mandatory: true,
      channels: { email: 'immediate' },
    });

    const audit = await node
      .admin()
      .get('/v1/access/audit?action=notificationPreferences.updated')
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThanOrEqual(2);
    expect(audit.body.items[0].details).toMatchObject({
      to: { 'security.passwordChanged': { email: 'daily' } },
    });
  });

  it('collapses by key: one notification, counted up', async () => {
    const editor = await node.user(['editor']);
    // The same key again: one notification, counted up, unread again, newest.
    const first = await notify(`user:${editor.id}`, {
      key: 'batch',
      data: commentData('One'),
    });
    await editor.agent.post(`/v1/notifications/${first}/read`).expect(200);
    const second = await notify(`user:${editor.id}`, {
      key: 'batch',
      data: commentData('Two'),
    });
    expect(second).not.toBe(first);
    const batched = await editor.agent
      .get('/v1/notifications?key=batch')
      .expect(200);
    expect(batched.body.items).toHaveLength(1);
    expect(batched.body.items[0]).toMatchObject({
      id: second,
      count: 2,
      read: false,
      body: '2 new comments on "Two"; the latest by Ada: Looks good.',
    });
    // The counted text is plural, in the request's language.
    const german = await editor.agent
      .get('/v1/notifications?key=batch&lang=de')
      .expect(200);
    expect(german.body.items[0].body).toBe(
      '2 neue Kommentare zu „Two“; der neueste von Ada: Looks good.',
    );
    await editor.agent.post(`/v1/notifications/${first}/read`).expect(404);
    // The outbox message of the one collapsed away finds nothing: no error.
    await deliver();
    expect((await row(second)).deliveredAt).toBeTruthy();
  });

  it('lists notifyMany ones newest first, after older ones (#849)', async () => {
    const editor = await node.user(['editor']);
    const older = await notify(`user:${editor.id}`);
    const service = node.app.get(NotificationsService);
    const txHost = node.app.get(TransactionHost);
    const ids = await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        service.notifyMany(
          tx,
          ['One', 'Two'].map((title) => ({
            type: 'testItem.commented' as NotificationType,
            to: `user:${editor.id}`,
            data: commentData(title),
          })),
        ),
      ),
    );
    const [one, two] = ids.flat();
    // Time-ordered ids (UUIDv7, as every row's), not random ones.
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const listed = await editor.agent.get('/v1/notifications').expect(200);
    expect(
      listed.body.items.map((item: { id: string }) => item.id),
    ).toEqual([two, one, older]);
  });

  it('lists with filters, marks all read up to a moment', async () => {
    const editor = await node.user(['editor']);
    const to = `user:${editor.id}`;
    const a = await notify(to);
    const b = await notify(to);
    const bCreated = (await row(b)).createdAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c = await notify(to, { data: commentData('C') });

    const all = await editor.agent.get('/v1/notifications').expect(200);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([c, b, a]);
    const before = new Date(bCreated.getTime() + 1).toISOString();
    const upTo = await editor.agent
      .post('/v1/notifications/read-all')
      .send({ before })
      .expect(200);
    expect(upTo.body).toEqual({ updated: 2 });
    const unread = await editor.agent
      .get('/v1/notifications?read=false')
      .expect(200);
    expect(unread.body.items.map((i: { id: string }) => i.id)).toEqual([c]);
    const d = await notify(to, { data: commentData('D') });
    const page1 = await editor.agent
      .get('/v1/notifications?read=false&limit=1')
      .expect(200);
    expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([d]);
    const page2 = await editor.agent
      .get(
        `/v1/notifications?read=false&limit=1&cursor=${page1.body.nextCursor}`,
      )
      .expect(200);
    expect(page2.body.items.map((i: { id: string }) => i.id)).toEqual([c]);
    expect(
      (
        await editor.agent
          .get('/v1/notifications?read=true&sort=createdAt')
          .expect(200)
      ).body.items.map((i: { id: string }) => i.id),
    ).toEqual([a, b]);
    expect(
      (
        await editor.agent
          .get('/v1/notifications?type=comment.mentioned')
          .expect(200)
      ).body.items,
    ).toEqual([]);
    expect(
      (
        await editor.agent
          .post('/v1/notifications/read-all')
          .send({})
          .expect(200)
      ).body,
    ).toEqual({ updated: 2 });
    await editor.agent.get('/v1/notifications?sort=nope').expect(400);
    await editor.agent.get('/v1/notifications?nope=1').expect(400);
  });

  it("bundles mail into hourly and daily digests, in the recipient's zone", async () => {
    const editor = await node.user(['editor']);
    await editor.agent
      .patch('/v1/auth/me')
      .send({ timezone: 'Asia/Dubai' })
      .expect(200);
    const email = await emailOf(editor.agent);
    const job = node.app.get(NotificationDigestJob);

    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'daily' } })
      .expect(200);
    const daily = await notify(`user:${editor.id}`);
    await deliver();
    const flagged = await row(daily);
    expect(flagged.digest).toBe('daily');
    expect(flagged.emailedAt).toBeNull();
    const due = flagged.digestDueAt!;
    // 08:00 in Dubai: 04:00 UTC, within the next day.
    expect(due.getUTCHours()).toBe(4);
    expect(due.getTime()).toBeGreaterThan(Date.now());
    expect(due.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(noticesTo(email)).toEqual([]);

    expect(await job.run(new Date(due.getTime() - 1000))).toEqual({
      mails: 0,
      items: 0,
    });
    expect(await job.run(new Date(due.getTime() + 1000))).toEqual({
      mails: 1,
      items: 1,
    });
    const mail = await node.waitForMail({
      to: email,
      subject: /1 new notification in/,
    });
    expect(mail.html).toContain('&quot;Direct&quot;');
    expect((await row(daily)).emailedAt).toBeTruthy();
    expect((await row(daily)).digest).toBeNull();

    // Hourly: due at once, two in one mail.
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'hourly' } })
      .expect(200);
    await notify(`user:${editor.id}`);
    await notify(`user:${editor.id}`);
    await deliver();
    expect(await job.run()).toEqual({ mails: 1, items: 2 });
    await node.waitForMail({ to: email, subject: /2 new notifications in/ });
  });

  it('deletes old notifications on retention', async () => {
    const editor = await node.user(['editor']);
    const to = `user:${editor.id}`;
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    await db()
      .insert(notifications)
      .values([
        {
          tenantId: node.tenantId,
          recipient: to,
          type: 'testItem.commented',
          data: {},
          createdAt: days(100),
          readAt: days(95),
        },
        {
          tenantId: node.tenantId,
          recipient: to,
          type: 'testItem.commented',
          data: {},
          createdAt: days(400),
        },
        {
          tenantId: node.tenantId,
          recipient: to,
          type: 'testItem.commented',
          data: {},
          createdAt: days(100),
        },
      ]);
    expect(await node.app.get(NotificationRetentionJob).run()).toBe(2);
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toHaveLength(1);
  });

  it("exports a principal's own notifications", async () => {
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);
    await notify(`user:${editor.id}`);
    await notify(`user:${other.id}`, {
      data: commentData('Not mine'),
    });
    const catalog = await editor.agent.get('/v1/data').expect(200);
    expect(
      catalog.body.exports.find(
        (e: { name: string }) => e.name === 'notifications',
      ).columns,
    ).toEqual([
      'id',
      'type',
      'title',
      'body',
      'link',
      'count',
      'read',
      'readAt',
      'createdAt',
    ]);
    const started = await editor.agent
      .post('/v1/data/exports')
      .send({ name: 'notifications', format: 'json' })
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
    const file = await node.http().get(local(status.result.url)).expect(200);
    expect(file.body).toHaveLength(1);
    expect(file.body[0]).toMatchObject({
      type: 'testItem.commented',
      title: 'New comment',
      body: 'Ada commented on "Direct": Looks good.',
      read: false,
    });
  });

  it('sends nothing to a recipient deactivated since, without a dead letter', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    const id = await notify(`user:${editor.id}`);
    await node
      .admin()
      .patch(`/v1/access/users/${editor.id}`)
      .send({ active: false })
      .expect(204);
    await deliver();
    expect((await row(id)).deliveredAt).toBeTruthy();
    expect(noticesTo(email)).toEqual([]);
    const ops = await node.admin().get('/v1/ops/outbox').expect(200);
    expect(ops.body.deadLetters).toEqual([]);
    expect(ops.body.notifications).toEqual({ undelivered: 0 });
  });

  it('shows and takes preferences in their typed shape; a value the channel does not take is a 400', async () => {
    const editor = await node.user(['editor']);
    const types = (
      await editor.agent.get('/v1/notifications/types').expect(200)
    ).body.items as { type: string; channels: object }[];
    // A user is offered `email` alone, every default one of its values.
    for (const item of types) {
      expect(Object.keys(item.channels)).toEqual(['email']);
      expect([false, 'immediate', 'hourly', 'daily']).toContain(
        (item.channels as { email: unknown }).email,
      );
    }
    const put = await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'hourly' } })
      .expect(200);
    expect(put.body.types['testItem.commented']).toEqual({ email: 'hourly' });
    const get = await editor.agent
      .get('/v1/notifications/preferences')
      .expect(200);
    expect(get.body).toEqual(put.body);

    // Not one of the values, nor a boolean `true`, nor a string for a flag.
    for (const email of ['often', true, 1, null]) {
      const response = await editor.agent
        .put('/v1/notifications/preferences')
        .send({ 'testItem.commented': { email } })
        .expect(400);
      expect(response.body.code).toBe('validation_failed');
      expect(paths(response.body)).toEqual(['testItem.commented.email']);
    }
    const client = await node.client();
    const refused = await node
      .http()
      .put('/v1/notifications/preferences')
      .set('Authorization', client.auth)
      .send({ 'testItem.commented': { webhook: 'yes' } })
      .expect(400);
    expect(paths(refused.body)).toEqual(['testItem.commented.webhook']);
    // Unchanged by the refused ones.
    expect(
      (await editor.agent.get('/v1/notifications/preferences').expect(200)).body
        .types['testItem.commented'],
    ).toEqual({ email: 'hourly' });
  });

  describe('POST /v1/notifications/test (development and tests only)', () => {
    it('sends the caller a test notification, in app and by mail, and nobody else', async () => {
      const editor = await node.user(['editor']);
      const other = await node.user(['editor']);
      const email = await emailOf(editor.agent);
      const otherEmail = await emailOf(other.agent);
      await editor.agent
        .patch('/v1/auth/me')
        .send({ locale: 'de' })
        .expect(200);

      const sent = await editor.agent
        .post('/v1/notifications/test')
        .expect(200);
      expect(sent.body).toEqual({ id: expect.any(String) });
      await deliver();

      const items = (await editor.agent.get('/v1/notifications').expect(200))
        .body.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: sent.body.id,
        type: 'system.test',
        title: 'Testbenachrichtigung',
        read: false,
        count: 1,
        data: { at: expect.any(String) },
      });
      expect(noticesTo(email)).toHaveLength(1);
      expect(noticesTo(otherEmail)).toEqual([]);
      expect(
        (await other.agent.get('/v1/notifications').expect(200)).body.items,
      ).toEqual([]);
      // Each call is its own notification.
      await editor.agent.post('/v1/notifications/test').expect(200);
      expect(
        (await editor.agent.get('/v1/notifications').expect(200)).body.items,
      ).toHaveLength(2);
    });

    it("respects the caller's preferences: no mail when they switched it off", async () => {
      const editor = await node.user(['editor']);
      const email = await emailOf(editor.agent);
      await editor.agent
        .put('/v1/notifications/preferences')
        .send({ 'system.test': { email: false } })
        .expect(200);
      await editor.agent.post('/v1/notifications/test').expect(200);
      await deliver();
      expect(
        (await editor.agent.get('/v1/notifications').expect(200)).body.items,
      ).toHaveLength(1);
      expect(noticesTo(email)).toEqual([]);
    });

    it('tells an API client live and by webhook', async () => {
      const receiver = await webhookReceiver();
      try {
        const client = await node.client();
        await node
          .http()
          .post('/v1/webhook-endpoints')
          .set('Authorization', client.auth)
          .send({ url: receiver.url, eventTypes: ['notification.created'] })
          .expect(201);
        const socket = await connect(node, client.key);
        sockets.push(socket);
        const live = new Promise<{ type: string }>((resolve) =>
          socket.once('notification', resolve),
        );
        await node
          .http()
          .post('/v1/notifications/test')
          .set('Authorization', client.auth)
          .expect(200);
        await deliver();
        await node.deliverWebhooks();
        expect((await live).type).toBe('system.test');
        expect(receiver.received.map((w) => w.body.type)).toEqual([
          'notification.created',
        ]);
      } finally {
        await receiver.close();
      }
    });

    it('needs a sign-in', async () => {
      await node.http().post('/v1/notifications/test').expect(401);
    });

    it('is refused to an administrator acting as someone', async () => {
      const editor = await node.user(['editor']);
      const admin = await node.signIn(
        process.env.ADMIN_EMAIL!,
        process.env.ADMIN_PASSWORD!,
      );
      await admin.post(`/v1/access/users/${editor.id}/impersonate`).expect(204);
      await admin.post('/v1/notifications/test').expect(403);
    });
  });
});
