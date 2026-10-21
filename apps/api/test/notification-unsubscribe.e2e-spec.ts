import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay } from '@nestjs/outbox';
import { TransactionHost } from '@nestjs-cls/transactional';
import { count, eq } from 'drizzle-orm';
import type request from 'supertest';
import { auditLog } from '../src/iam/iam.tables.js';
import { loadOrCreateSecret } from '../src/core/database/drizzle.js';
import { inTransaction } from '../src/core/database/transactions.js';
import { NotificationDigestJob } from '../src/platform/notifications/notification-digest.job.js';
import { NotificationUnsubscribeLinks } from '../src/platform/notifications/notification-unsubscribe.js';
import type { NotificationType } from '../src/platform/notifications/notification.types.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import { bootApp, type TestApp } from './support.js';

const FORM = 'List-Unsubscribe=One-Click';
const DAY = 86_400_000;

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

  /** What the web page does, and a mail scanner that follows the link: GET it, with no cookie and no token header. */
  const describeLink = (token: string) =>
    node.http().get(`/v1/notifications/unsubscribe/${token}`);

  async function notify(
    to: string,
    type: string,
    data: Record<string, unknown> = {
      recordId: randomUUID(),
      commentId: randomUUID(),
      title: 'Direct',
      by: 'Ada',
      excerpt: 'Looks good.',
    },
  ) {
    const txHost = node.app.get(TransactionHost);
    await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        node.app.get(NotificationsService).notify(tx, {
          type: type as NotificationType,
          to,
          data,
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
    await notify(`user:${editor.id}`, 'security.passwordChanged', {
      via: 'change',
      ip: '203.0.113.7',
    });
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

  it('only the POST unsubscribes, and it needs the one-click body', async () => {
    const editor = await node.user(['editor']);
    const token = links().signType(editor.id, 'testItem.commented');
    // A scanner following the link in a mail must change nothing.
    await describeLink(token).expect(200);
    await oneClick(token, '').expect(400);
    await oneClick(token, 'List-Unsubscribe=Something').expect(400);
    expect((await preferences(editor.agent))['testItem.commented']).toEqual({
      email: 'daily',
    });
  });

  it('is in the OpenAPI document as a public route, GET and POST', async () => {
    const doc = (await node.http().get('/api-json').expect(200)).body;
    const route = doc.paths['/v1/notifications/unsubscribe/{token}'];
    expect(route?.post).toBeDefined();
    expect(route?.get).toBeDefined();
    expect(route.post.security ?? []).toEqual([]);
    expect(route.get.security ?? []).toEqual([]);
    expect(route.get.responses['400']).toBeDefined();
  });

  describe('GET: what the link stops (read-only)', () => {
    it("names the type in the request's language, without a sign-in and without the person's data", async () => {
      const editor = await node.user(['editor']);
      const token = links().signType(editor.id, 'comment.mentioned');

      const english = await describeLink(token).expect(200);
      expect(english.body).toEqual({
        kind: 'type',
        label: 'Mentioned in a comment',
      });
      const german = await describeLink(token)
        .set('Accept-Language', 'de')
        .expect(200);
      expect(german.body).toEqual({
        kind: 'type',
        label: 'In einem Kommentar erwähnt',
      });
      expect(german.headers['content-language']).toBe('de');

      // Neither the email nor the id of the person it is for.
      const answered = JSON.stringify([english.body, german.body]);
      expect(answered).not.toContain(editor.id);
      expect(answered).not.toContain(editor.email);
    });

    it('names the modes of a digest', async () => {
      const editor = await node.user(['editor']);
      const hourly = await describeLink(
        links().signDigests(editor.id, ['hourly']),
      ).expect(200);
      expect(hourly.body).toEqual({ kind: 'digest', modes: ['hourly'] });
      const both = await describeLink(
        links().signDigests(editor.id, ['hourly', 'daily']),
      ).expect(200);
      expect(both.body).toEqual({ kind: 'digest', modes: ['hourly', 'daily'] });
    });

    it('names no label for a type the POST would not switch off', async () => {
      const editor = await node.user(['editor']);
      // Mandatory (its mail carries no link, so only a hand-made token names it), and no longer declared.
      for (const type of ['security.passwordChanged', 'no.such.type']) {
        const answered = await describeLink(
          links().signType(editor.id, type),
        ).expect(200);
        expect(answered.body).toEqual({ kind: 'type', label: null });
      }
    });

    it('changes nothing: no preference, no audit entry, and the link is not spent', async () => {
      const editor = await node.user(['editor']);
      const token = links().signType(editor.id, 'testItem.commented');
      await editor.agent
        .put('/v1/notifications/preferences')
        .send({ 'testItem.commented': { email: 'immediate' } })
        .expect(200);
      const before = await preferences(editor.agent);
      const audited = async () =>
        (await node.db.select({ n: count() }).from(auditLog))[0]!.n;
      const entries = await audited();

      for (let attempt = 0; attempt < 3; attempt++) {
        await describeLink(token).expect(200);
      }

      expect(await audited()).toBe(entries);
      expect(await preferences(editor.agent)).toEqual(before);
      expect((await preferences(editor.agent))['testItem.commented']).toEqual({
        email: 'immediate',
      });

      // The POST still works after the GETs, and the GET still answers after it.
      await oneClick(token).expect(204);
      expect((await preferences(editor.agent))['testItem.commented']).toEqual({
        email: false,
      });
      expect((await describeLink(token).expect(200)).body).toEqual({
        kind: 'type',
        label: 'Comment on a test item you watch',
      });
    });

    it('refuses a forged, foreign, expired, wrong-purpose or gone-account token with the POST’s one answer', async () => {
      const editor = await node.user(['editor']);
      const secret = await loadOrCreateSecret(node.db, 'JWT_SECRET', () =>
        randomBytes(32).toString('base64url'),
      );
      const issuer = node.app.get(ConfigService).get('APP_URL');
      const now = new NotificationUnsubscribeLinks(secret, issuer);
      // The same key and issuer as the app's, a year and a bit ago: only the age is wrong.
      const old = new NotificationUnsubscribeLinks(
        secret,
        issuer,
        () => Date.now() - 400 * DAY,
      ).signType(editor.id, 'testItem.commented');
      expect(
        await links().verify(now.signType(editor.id, 'testItem.commented')),
      ).not.toBeNull();
      expect(await links().verify(old)).toBeNull();

      const [header, , signature] = links()
        .signType(editor.id, 'testItem.commented')
        .split('.');
      const accessToken = (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: editor.email, password: editor.password })
          .expect(200)
      ).body.accessToken as string;
      const tokens = [
        'garbage',
        new NotificationUnsubscribeLinks(
          'another-secret-another-secret-another',
          issuer,
        ).signType(editor.id, 'testItem.commented'),
        `${header}.${Buffer.from(
          JSON.stringify({ sub: editor.id, nt: 'comment.mentioned' }),
        ).toString('base64url')}.${signature}`,
        old,
        accessToken, // signed by the app, but not a link for this
        links().signType(randomUUID(), 'testItem.commented'), // no such account
        links().signDigests(randomUUID(), ['daily']),
      ];

      // The request's own id and path are the only things that differ.
      const stable = (body: object) => ({
        ...body,
        requestId: undefined,
        instance: undefined,
      });
      const answers = [];
      for (const token of tokens) {
        const got = await describeLink(token).expect(400);
        const posted = await oneClick(token).expect(400);
        // Nothing about the problem tells the token apart: not the status, the type, the body.
        expect(got.headers['content-type']).toBe(
          posted.headers['content-type'],
        );
        expect(stable(got.body)).toEqual(stable(posted.body));
        answers.push({
          type: got.headers['content-type'],
          body: stable(got.body),
        });
      }
      expect(answers).toHaveLength(tokens.length);
      for (const answer of answers) {
        expect(answer).toEqual(answers[0]);
      }
      expect((await preferences(editor.agent))['testItem.commented']).toEqual({
        email: 'daily',
      });
    });

    it('is throttled exactly like the POST: the default 600 a minute per address', async () => {
      // The limit comes before the handler, so any token counts: one that costs nothing to refuse.
      const answers = async (send: () => PromiseLike<request.Response>) => {
        const statuses: number[] = [];
        let last!: request.Response;
        for (let sent = 0; sent < 620; sent += 100) {
          const batch = await Promise.all(
            Array.from({ length: Math.min(100, 620 - sent) }, send),
          );
          statuses.push(...batch.map((response) => response.status));
          last = batch[batch.length - 1]!;
        }
        return { statuses, last };
      };
      const got = await answers(() => describeLink('garbage'));
      const posted = await answers(() => oneClick('garbage'));

      for (const { statuses, last } of [got, posted]) {
        expect(statuses.filter((status) => status === 400)).toHaveLength(600);
        expect(statuses.filter((status) => status === 429)).toHaveLength(20);
        expect(last.status).toBe(429);
        expect(last.body).toMatchObject({ status: 429, code: 'rate_limited' });
        expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
      }
    });
  });
});
