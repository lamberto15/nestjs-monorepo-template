import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OutboxRelay } from '@nestjs/outbox';
import { eq } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import type request from 'supertest';
import { inTransaction } from '../src/core/database/transactions.js';
import { NotificationDigestJob } from '../src/platform/notifications/notification-digest.job.js';
import { NotificationRetentionJob } from '../src/platform/notifications/notification-retention.job.js';
import { notifications } from '../src/platform/notifications/notifications.tables.js';
import {
  NotificationsService,
  type NotifyInput,
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

  /** Writes a note and lets its publication workflow publish it. */
  async function publish(auth: string | request.Agent) {
    const note = (
      await node.writeNote(auth, { title: 'Hello', body: '' }).expect(201)
    ).body as { id: string };
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    return note;
  }

  /** A notification sent straight from code, as a feature's service does. */
  async function notify(to: string, input: Partial<NotifyInput> = {}) {
    const service = node.app.get(NotificationsService);
    const txHost = node.app.get(TransactionHost);
    // In the seeded tenant, as a feature notifies from a request or a job.
    const [id] = await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        service.notify(tx, {
          type: 'note.published',
          to,
          data: { noteId: randomUUID(), title: 'Direct' },
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
    const note = await publish(editor.agent);
    await deliver();

    const page = await editor.agent.get('/v1/notifications').expect(200);
    expect(page.body.items).toHaveLength(1);
    const item = page.body.items[0];
    expect(item).toMatchObject({
      type: 'note.published',
      title: 'Notiz veröffentlicht',
      body: '„Hello“ ist jetzt veröffentlicht.',
      data: { noteId: note.id, title: 'Hello' },
      link: `/notes/${note.id}`,
      key: null,
      count: 1,
      read: false,
      readAt: null,
    });
    // The texts follow the request's language, not the stored one.
    const english = await editor.agent
      .get('/v1/notifications?lang=en')
      .expect(200);
    expect(english.body.items[0].title).toBe('Note published');
    expect(english.body.items[0].body).toBe('"Hello" is now published.');
    expect(
      (await editor.agent.get('/v1/notifications/unread-count').expect(200))
        .body,
    ).toEqual({ unread: 1 });

    // The mail, in German, with the link into the web app.
    const mail = await node.waitForMail({
      to: email,
      subject: /Notiz veröffentlicht/,
    });
    expect(mail.html).toContain('„Hello“ ist jetzt veröffentlicht.');
    expect(mail.html).toContain(`https://web.example.com/notes/${note.id}`);

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
    ).toEqual({ unread: 0 });
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
      const liveCount = new Promise<{ unread: number }>((resolve) =>
        socket.once('notifications.unread-count', resolve),
      );

      const note = await publish(client.auth);
      await deliver(); // the handler: it dispatches the webhook through the outbox
      await node.deliverWebhooks();

      expect(receiver.received.map((w) => w.body.type)).toEqual([
        'notification.created',
      ]);
      expect(receiver.received[0]!.body.data).toMatchObject({
        type: 'note.published',
        title: 'Note published',
        data: { noteId: note.id, title: 'Hello' },
        count: 1,
      });
      const item = await live;
      expect(item.title).toBe('Note published');
      const list = await node
        .http()
        .get('/v1/notifications')
        .set('Authorization', client.auth)
        .expect(200);
      expect(list.body.items[0].id).toBe(item.id);

      // Every connection keeps up: the count after the delivery, each change.
      const next = <T>(event: string) =>
        new Promise<T>((resolve) => socket.once(event, resolve));
      expect(await liveCount).toEqual({ unread: 1 });
      const [read, afterRead] = await Promise.all([
        next<{ id: string; readAt: string }>('notification.read'),
        next<{ unread: number }>('notifications.unread-count'),
        node
          .http()
          .post(`/v1/notifications/${item.id}/read`)
          .set('Authorization', client.auth)
          .expect(200),
      ]);
      expect(read.id).toBe(item.id);
      expect(read.readAt).toBeTruthy();
      expect(afterRead).toEqual({ unread: 0 });
      const [removed] = await Promise.all([
        next<{ id: string }>('notification.removed'),
        node
          .http()
          .delete(`/v1/notifications/${item.id}`)
          .set('Authorization', client.auth)
          .expect(204),
      ]);
      expect(removed).toEqual({ id: item.id });
      // No mail for a system.
      expect(node.mailbox.find({ subject: /Note published/ })).toBeUndefined();

      // Its choices: the webhook only; a client has no email to set.
      const types = await node
        .http()
        .get('/v1/notifications/types')
        .set('Authorization', client.auth)
        .expect(200);
      expect(
        types.body.items.find(
          (t: { type: string }) => t.type === 'note.published',
        ),
      ).toEqual({
        type: 'note.published',
        label: 'Note published',
        mandatory: false,
        channels: { webhook: true },
      });
      const refused = await node
        .http()
        .put('/v1/notifications/preferences')
        .set('Authorization', client.auth)
        .send({ 'note.published': { email: false } })
        .expect(400);
      expect(paths(refused.body)).toEqual(['note.published.email']);
      const off = await node
        .http()
        .put('/v1/notifications/preferences')
        .set('Authorization', client.auth)
        .send({ 'note.published': { webhook: false } })
        .expect(200);
      expect(off.body.types['note.published']).toEqual({ webhook: false });
      await publish(client.auth);
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
    ).toEqual({
      types: {
        'note.published': { email: 'immediate' },
        'note.changed': { email: 'daily' },
        'note.commented': { email: 'daily' },
        'note.deleted': { email: 'immediate' },
        'comment.mentioned': { email: 'immediate' },
        'approval.requested': { email: 'immediate' },
        'approval.reminder': { email: 'immediate' },
        'approval.escalated': { email: 'immediate' },
        'approval.approved': { email: 'immediate' },
        'approval.rejected': { email: 'immediate' },
        'approval.changesRequested': { email: 'immediate' },
        'approval.expired': { email: 'immediate' },
        'approval.failed': { email: 'immediate' },
        'approval.cancelled': { email: false },
        'security.newSignIn': { email: 'immediate' },
        'security.passwordChanged': { email: 'immediate' },
        'security.mfaChanged': { email: 'immediate' },
        'security.apiKeyRotated': { email: false },
      },
    });
    const changed = await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'note.published': { email: false } })
      .expect(200);
    expect(changed.body.types['note.published']).toEqual({ email: false });

    await publish(editor.agent);
    await deliver();
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toHaveLength(1);
    expect(node.mailbox.find({ to: email })).toBeUndefined();

    // Invalid settings, each named.
    const invalid = async (body: object, path: string) => {
      const response = await editor.agent
        .put('/v1/notifications/preferences')
        .send(body)
        .expect(400);
      expect(response.body.code).toBe('validation_failed');
      expect(paths(response.body)).toEqual([path]);
    };
    await invalid({ 'note.deleted': { email: false } }, 'note.deleted.email');
    await invalid({ 'note.nope': { email: false } }, 'note.nope');
    await invalid({ 'note.published': { sms: true } }, 'note.published.sms');
    await invalid(
      { 'note.published': { email: 'often' } },
      'note.published.email',
    );
    // A mandatory type may change its frequency.
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'note.deleted': { email: 'daily' } })
      .expect(200);
    const types = await editor.agent.get('/v1/notifications/types').expect(200);
    expect(
      types.body.items.find((t: { type: string }) => t.type === 'note.deleted'),
    ).toEqual({
      type: 'note.deleted',
      label: 'Note deleted by someone else',
      mandatory: true,
      channels: { email: 'immediate' },
    });

    const audit = await node
      .admin()
      .get('/v1/access/audit?action=notificationPreferences.updated')
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThanOrEqual(2);
    expect(audit.body.items[0].details).toMatchObject({
      to: { 'note.deleted': { email: 'daily' } },
    });
  });

  it('sends a mandatory notification when someone else deletes a note, and collapses by key', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    const note = (
      await node
        .writeNote(editor.agent, { title: 'Mine', body: '' })
        .expect(201)
    ).body as { id: string };
    await node.admin().delete(`/v1/notes/${note.id}`).expect(204);
    await deliver();
    const list = await editor.agent.get('/v1/notifications').expect(200);
    expect(list.body.items[0]).toMatchObject({
      type: 'note.deleted',
      title: 'Note deleted',
      body: '"Mine" was deleted by Administrator.',
    });
    await node.waitForMail({ to: email, subject: /Note deleted/ });

    // The same key again: one notification, counted up, unread again, newest.
    const first = await notify(`user:${editor.id}`, {
      key: 'batch',
      data: { noteId: randomUUID(), title: 'One' },
    });
    await editor.agent.post(`/v1/notifications/${first}/read`).expect(200);
    const second = await notify(`user:${editor.id}`, {
      key: 'batch',
      data: { noteId: randomUUID(), title: 'Two' },
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
      body: '2 of your notes were published; the latest is "Two".',
    });
    await editor.agent.post(`/v1/notifications/${first}/read`).expect(404);
    // The outbox message of the one collapsed away finds nothing: no error.
    await deliver();
    expect((await row(second)).deliveredAt).toBeTruthy();
  });

  it('lists with filters, marks all read up to a moment', async () => {
    const editor = await node.user(['editor']);
    const to = `user:${editor.id}`;
    const a = await notify(to);
    const b = await notify(to);
    const bCreated = (await row(b)).createdAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c = await notify(to, { data: { noteId: randomUUID(), title: 'C' } });

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
          .get('/v1/notifications?type=note.deleted')
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
    ).toEqual({ updated: 1 });
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
      .send({ 'note.published': { email: 'daily' } })
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
    expect(node.mailbox.find({ to: email })).toBeUndefined();

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
    expect(mail.html).toContain('&quot;Direct&quot; is now published.');
    expect((await row(daily)).emailedAt).toBeTruthy();
    expect((await row(daily)).digest).toBeNull();

    // Hourly: due at once, two in one mail.
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'note.published': { email: 'hourly' } })
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
          type: 'note.published',
          data: {},
          createdAt: days(100),
          readAt: days(95),
        },
        {
          tenantId: node.tenantId,
          recipient: to,
          type: 'note.published',
          data: {},
          createdAt: days(400),
        },
        {
          tenantId: node.tenantId,
          recipient: to,
          type: 'note.published',
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
      data: { noteId: randomUUID(), title: 'Not mine' },
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
      type: 'note.published',
      title: 'Note published',
      body: '"Direct" is now published.',
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
    expect(node.mailbox.find({ to: email })).toBeUndefined();
    const ops = await node.admin().get('/v1/ops/outbox').expect(200);
    expect(ops.body.deadLetters).toEqual([]);
    expect(ops.body.notifications).toEqual({ undelivered: 0 });
  });
});
