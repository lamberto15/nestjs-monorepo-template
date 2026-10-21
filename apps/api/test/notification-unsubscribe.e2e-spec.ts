import { randomUUID } from 'node:crypto';
import { OutboxRelay } from '@nestjs/outbox';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq } from 'drizzle-orm';
import type request from 'supertest';
import { auditLog } from '../src/iam/iam.tables.js';
import { inTransaction } from '../src/core/database/transactions.js';
import { NotificationDigestJob } from '../src/platform/notifications/notification-digest.job.js';
import { NotificationUnsubscribeLinks } from '../src/platform/notifications/notification-unsubscribe.js';
import type { NotificationType } from '../src/platform/notifications/notification.types.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import { bootApp, type TestApp } from './support.js';

const FORM = 'List-Unsubscribe=One-Click';

describe('notification mail: one-click unsubscribe (RFC 8058, e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const links = () => node.app.get(NotificationUnsubscribeLinks);
  const deliver = () => node.app.get(OutboxRelay).runOnce();
  const emailOf = async (agent: request.Agent) =>
    (await agent.get('/v1/auth/me').expect(200)).body.user.email as string;

  /** What a mail client does: POST the form, with no cookie and no token header. */
  const oneClick = (token: string, body: string | object = FORM) =>
    node
      .http()
      .post(`/v1/notifications/unsubscribe/${token}`)
      .type('form')
      .send(body);

  async function notify(to: string, type: string) {
    const txHost = node.app.get(TransactionHost);
    await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        node.app.get(NotificationsService).notify(tx, {
          type: type as NotificationType,
          to,
          data: {
            recordId: randomUUID(),
            commentId: randomUUID(),
            title: 'Direct',
            by: 'Ada',
            excerpt: 'Looks good.',
          },
        }),
      ),
    );
  }

  const preferences = async (agent: request.Agent) =>
    (await agent.get('/v1/notifications/preferences').expect(200)).body.types;

  /** The unsubscribe entries: account-level (no tenant), so not in a tenant's audit route. */
  const auditEntries = async () =>
    (
      await node.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'notificationPreferences.updated'))
    ).map((entry) => ({ details: entry.details as Record<string, unknown> }));

  it('turns the type off without a sign-in, audited, and again changes nothing', async () => {
    const editor = await node.user(['editor']);
    const token = links().signType(editor.id, 'testItem.commented');
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'immediate' } })
      .expect(200);

    await oneClick(token).expect(204);
    expect((await preferences(editor.agent))['testItem.commented']).toEqual({
      email: false,
    });
    const entries = (await auditEntries()).filter(
      (entry) => entry.details.via === 'unsubscribe',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({
      types: ['testItem.commented'],
      to: { 'testItem.commented': { email: false } },
    });

    // Pressed again (a mail client retries): the same answer, no new entry.
    await oneClick(token).expect(204);
    expect(
      (await auditEntries()).filter(
        (entry) => entry.details.via === 'unsubscribe',
      ),
    ).toHaveLength(1);

    // The mail stops.
    await notify(`user:${editor.id}`, 'testItem.commented');
    await deliver();
    expect(
      node.mailbox.filter({ to: await emailOf(editor.agent) }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            subject: expect.stringMatching(/New comment/),
          }),
        }),
      ]),
    );
  });

  it('accepts the JSON body of the web page too', async () => {
    const editor = await node.user(['editor']);
    await node
      .http()
      .post(
        `/v1/notifications/unsubscribe/${links().signType(editor.id, 'testItem.commented')}`,
      )
      .send({ 'List-Unsubscribe': 'One-Click' })
      .expect(204);
    expect((await preferences(editor.agent))['testItem.commented']).toEqual({
      email: false,
    });
  });

  it('keeps the other settings, and never switches a mandatory type off', async () => {
    const editor = await node.user(['editor']);
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'security.passwordChanged': { email: 'daily' } })
      .expect(200);

    await oneClick(
      links().signType(editor.id, 'security.passwordChanged'),
    ).expect(204);
    await oneClick(links().signType(editor.id, 'testItem.commented')).expect(
      204,
    );

    const types = await preferences(editor.agent);
    expect(types['security.passwordChanged']).toEqual({ email: 'daily' });
    expect(types['testItem.commented']).toEqual({ email: false });
    expect(types['comment.mentioned']).toEqual({ email: 'immediate' });
  });

  it('turns off the types of a digest, by its modes', async () => {
    const editor = await node.user(['editor']);
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({
        'testItem.commented': { email: 'hourly' },
        'comment.mentioned': { email: 'daily' },
      })
      .expect(200);

    await oneClick(links().signDigests(editor.id, ['hourly'])).expect(204);
    const types = await preferences(editor.agent);
    expect(types['testItem.commented']).toEqual({ email: false });
    expect(types['comment.mentioned']).toEqual({ email: 'daily' });
    expect(types['security.passwordChanged']).toEqual({ email: 'immediate' });
  });

  it('puts the unsubscribe link in the footer of a mail and of a digest, none on a mandatory type', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'immediate' } })
      .expect(200);
    await notify(`user:${editor.id}`, 'testItem.commented');
    await deliver();
    const mail = await node.waitForMail({ to: email, subject: /New comment/ });
    const url =
      /href="(https:\/\/web\.example\.com\/unsubscribe\?token=[^"]+)"/.exec(
        mail.html ?? '',
      )?.[1];
    expect(url).toBeDefined();
    const token = decodeURIComponent(new URL(url!).searchParams.get('token')!);
    expect(await links().verify(token)).toEqual({
      userId: editor.id,
      type: 'testItem.commented',
    });

    // A mandatory type (immediate by default): no link.
    await notify(`user:${editor.id}`, 'security.passwordChanged');
    await deliver();
    for (const sent of node.mailbox.filter({ to: email })) {
      if (/password/i.test(sent.message.subject)) {
        expect(sent.html ?? '').not.toContain('/unsubscribe?token=');
      }
    }

    // The digest: a link for the modes it lists.
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': { email: 'hourly' } })
      .expect(200);
    await notify(`user:${editor.id}`, 'testItem.commented');
    await deliver();
    await node.app
      .get(NotificationDigestJob)
      .run(new Date(Date.now() + 2 * 3_600_000));
    const digest = await node.waitForMail({
      to: email,
      subject: /new notification/,
    });
    const digestToken = decodeURIComponent(
      new URL(
        /href="(https:\/\/web\.example\.com\/unsubscribe\?token=[^"]+)"/.exec(
          digest.html ?? '',
        )![1]!,
      ).searchParams.get('token')!,
    );
    expect(await links().verify(digestToken)).toEqual({
      userId: editor.id,
      digests: ['hourly'],
    });
  });

  it('refuses a forged, foreign, expired-kind or malformed token with one answer', async () => {
    const editor = await node.user(['editor']);
    const other = new NotificationUnsubscribeLinks(
      'another-secret-another-secret-another',
      'http://127.0.0.1',
    );
    const [header, , signature] = links()
      .signType(editor.id, 'testItem.commented')
      .split('.');
    const swapped = `${header}.${Buffer.from(
      JSON.stringify({ sub: editor.id, nt: 'comment.mentioned' }),
    ).toString('base64url')}.${signature}`;
    const answers = [];
    for (const token of [
      other.signType(editor.id, 'testItem.commented'),
      swapped,
      'garbage',
      links().signType(randomUUID(), 'testItem.commented'), // no such account
    ]) {
      const response = await oneClick(token).expect(400);
      answers.push(response.body.message);
    }
    expect(new Set(answers).size).toBe(1);
    expect((await preferences(editor.agent))['testItem.commented']).toEqual({
      email: 'daily',
    });
    expect((await preferences(editor.agent))['comment.mentioned']).toEqual({
      email: 'immediate',
    });
  });

  it('is POST only, and needs the one-click body', async () => {
    const editor = await node.user(['editor']);
    const token = links().signType(editor.id, 'testItem.commented');
    // A scanner following the link in a mail must change nothing.
    await node.http().get(`/v1/notifications/unsubscribe/${token}`).expect(404);
    await oneClick(token, '').expect(400);
    await oneClick(token, 'List-Unsubscribe=Something').expect(400);
    expect((await preferences(editor.agent))['testItem.commented']).toEqual({
      email: 'daily',
    });
  });

  it('is in the OpenAPI document as a public route', async () => {
    const doc = (await node.http().get('/api-json').expect(200)).body;
    const operation = doc.paths['/v1/notifications/unsubscribe/{token}']?.post;
    expect(operation).toBeDefined();
    expect(operation.security ?? []).toEqual([]);
  });
});
