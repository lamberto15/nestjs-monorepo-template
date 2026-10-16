import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { MailQueue } from '../src/core/mail/mail-queue.js';
import { mailSuppressions } from '../src/platform/deliverability/deliverability.tables.js';
import { ResetPasswordMail } from '../src/iam/account/account.mails.js';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { MailEventsRetentionJob } from '../src/platform/deliverability/mail-events-retention.job.js';
import {
  publicKeyOf,
  SnsGateway,
} from '../src/platform/deliverability/sns/sns-gateway.js';
import {
  type SnsMessage,
  snsStringToSign,
} from '../src/platform/deliverability/sns/sns-message.js';
import { NotificationMail } from '../src/platform/notifications/notification.mails.js';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads (imports are hoisted, so this is too): this
// file's apps accept the test topic and suppress after two soft bounces.
const TOPIC = vi.hoisted(() => {
  const topic = 'arn:aws:sns:eu-central-1:123456789012:ses-feedback';
  process.env.SES_SNS_TOPIC_ARNS = topic;
  process.env.MAIL_SOFT_BOUNCE_THRESHOLD = '2';
  return topic;
});

/** The key pair standing in for SNS's; the fake gateway serves its public key. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const CERT_URL =
  'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-e2e.pem';

class FakeGateway implements SnsGateway {
  readonly confirmed: string[] = [];
  async certificate(): Promise<KeyObject> {
    return publicKeyOf(
      publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
  }
  async confirm(url: string) {
    this.confirmed.push(url);
  }
}

/** An SNS notification carrying an SES message, signed as SNS signs it. */
function snsNotification(
  message: object | string,
  overrides: Partial<SnsMessage> = {},
  key = privateKey,
): SnsMessage {
  const notification: SnsMessage = {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: TOPIC,
    Subject: 'Amazon SES Email Event Notification',
    Message: typeof message === 'string' ? message : JSON.stringify(message),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    SigningCertURL: CERT_URL,
    Signature: '',
    ...overrides,
  };
  notification.Signature = createSign(
    notification.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
  )
    .update(snsStringToSign(notification), 'utf8')
    .sign(key, 'base64');
  return notification;
}

const bounce = (address: string, bounceType = 'Permanent') => ({
  notificationType: 'Bounce',
  bounce: {
    bounceType,
    bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
    bouncedRecipients: [
      { emailAddress: address, status: '5.1.1', diagnosticCode: 'smtp; 550' },
    ],
    timestamp: new Date().toISOString(),
  },
  mail: { timestamp: new Date().toISOString() },
});
const complaint = (address: string) => ({
  notificationType: 'Complaint',
  complaint: {
    complainedRecipients: [{ emailAddress: address }],
    complaintFeedbackType: 'abuse',
    timestamp: new Date().toISOString(),
  },
});
const delivery = (address: string) => ({
  notificationType: 'Delivery',
  delivery: { recipients: [address], timestamp: new Date().toISOString() },
});

describe('email deliverability (e2e)', () => {
  let node: TestApp;
  let gateway: FakeGateway;

  beforeAll(async () => {
    gateway = new FakeGateway();
    // No AWS in a test: the gateway that fetches certificates and confirms subscriptions is replaced.
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(SnsGateway).useValue(gateway),
    );
  });
  afterAll(async () => {
    await node.close();
  });

  /** POSTs as SNS does: JSON as text/plain. */
  const post = (body: SnsMessage | string, provider = 'ses') =>
    node
      .http()
      .post(`/v1/webhooks/mail/${provider}`)
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .set('x-amz-sns-message-type', 'Notification')
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  /** The list entry of an address once the queue has written it (undefined when `until` is never met). */
  async function entry(
    address: string,
    until: (row: Record<string, any>) => boolean = () => true,
  ) {
    for (let tries = 0; tries < 100; tries++) {
      const page = await node
        .admin()
        .get(`/v1/mail/suppressions?address=${encodeURIComponent(address)}`)
        .expect(200);
      const row = page.body.items[0];
      if (row && until(row)) {
        return row as Record<string, any>;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return undefined;
  }

  /** A user whose address and password the test knows. */
  async function person(roles: string[] = ['viewer']) {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const password = newPassword();
    const created = await node
      .admin()
      .post('/v1/access/users')
      .send({
        email,
        name: 'Ada',
        password,
        roleIds: await node.roleIds(...roles),
      })
      .expect(201);
    return { id: created.body.id as string, email, password };
  }

  it('suppresses a hard-bounced address from a signed SNS notification, once, with an audit entry by the intake job', async () => {
    const address = `Bounced-${randomUUID().slice(0, 6)}@Example.com`;
    const notification = snsNotification(bounce(address));
    const first = await post(notification).expect(200);
    expect(first.body).toEqual({ received: true, kind: 'events', events: 1 });

    const row = await entry(address);
    expect(row).toMatchObject({
      address: address.toLowerCase(),
      reason: 'hard_bounce',
      source: 'ses',
      events: 1,
      softBounces: 0,
      lastDetail: 'Permanent/General: 5.1.1: smtp; 550',
      createdBy: 'system:mail-intake',
    });
    expect(row!.suppressedAt).not.toBeNull();

    // SNS redelivers the same message: accepted, nothing changes.
    await post(notification).expect(200);
    const sameAgain = snsNotification(bounce(address), {
      MessageId: notification.MessageId,
      Timestamp: notification.Timestamp,
    });
    await post(sameAgain).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await entry(address))!.events).toBe(1);

    const audit = await node
      .admin()
      .get(
        `/v1/access/audit?action=mailSuppression.created&targetId=${row!.id}`,
      )
      .expect(200);
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0]).toMatchObject({
      actor: 'system:mail-intake',
      actorLabel: 'System: Mail intake',
    });

    const one = await node
      .admin()
      .get(`/v1/mail/suppressions/${row!.id}`)
      .expect(200);
    expect(one.body.id).toBe(row!.id);
  });

  it('counts soft bounces, resets them on a delivery, and suppresses at the threshold', async () => {
    const address = `soft-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(bounce(address, 'Transient'))).expect(200);
    const watched = await entry(address);
    expect(watched).toMatchObject({
      reason: 'soft_bounce',
      softBounces: 1,
      suppressedAt: null,
    });
    // Watched, not suppressed: the mail goes out.
    expect(
      (
        await node
          .admin()
          .get(
            `/v1/mail/suppressions?address=${address}&suppressedAt.isNull=true`,
          )
          .expect(200)
      ).body.items,
    ).toHaveLength(1);

    await post(snsNotification(delivery(address))).expect(200);
    expect(await entry(address, (row) => row.softBounces === 0)).toBeDefined();

    await post(snsNotification(bounce(address, 'Transient'))).expect(200);
    await post(snsNotification(bounce(address, 'Undetermined'))).expect(200);
    const suppressed = await entry(address, (row) => row.suppressedAt !== null);
    expect(suppressed).toMatchObject({
      reason: 'soft_bounce',
      softBounces: 2,
      events: 3,
    });
  });

  it('keeps the strongest reason: a complaint outranks a later hard bounce, a hard bounce replaces a soft one', async () => {
    const address = `rank-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(complaint(address))).expect(200);
    const complained = await entry(address);
    expect(complained).toMatchObject({
      reason: 'complaint',
      lastDetail: 'abuse',
    });
    await post(snsNotification(bounce(address))).expect(200);
    const after = await entry(address, (row) => row.events === 2);
    expect(after).toMatchObject({
      reason: 'complaint',
      suppressedAt: complained!.suppressedAt,
    });

    const soft = `soft-hard-${randomUUID().slice(0, 6)}@example.com`;
    await post(snsNotification(bounce(soft, 'Transient'))).expect(200);
    await entry(soft);
    await post(snsNotification(bounce(soft), { SignatureVersion: '2' })).expect(
      200,
    );
    const upgraded = await entry(soft, (row) => row.suppressedAt !== null);
    expect(upgraded).toMatchObject({ reason: 'hard_bounce', softBounces: 0 });
    const audit = await node
      .admin()
      .get(
        `/v1/access/audit?action=mailSuppression.created&targetId=${upgraded!.id}`,
      )
      .expect(200);
    expect(audit.body.items).toHaveLength(1);
  });

  it('refuses what is not a signed SNS message from the configured topic, and confirms a subscription', async () => {
    const address = `refused-${randomUUID().slice(0, 6)}@example.com`;
    expect((await post('not json').expect(400)).body.code).toBe(
      'sns_malformed',
    );
    expect((await post('').expect(400)).body.code).toBe('sns_malformed');
    await post(snsNotification(bounce(address)), 'postmark').expect(404);

    const forged = snsNotification(bounce(address));
    forged.Message = JSON.stringify(bounce(address, 'Transient'));
    expect((await post(forged).expect(401)).body.code).toBe(
      'sns_signature_invalid',
    );
    const foreign = snsNotification(
      bounce(address),
      {},
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    );
    await post(foreign).expect(401);
    expect(
      (
        await post(
          snsNotification(bounce(address), { TopicArn: `${TOPIC}-other` }),
        ).expect(403)
      ).body.code,
    ).toBe('sns_topic_not_allowed');
    expect(
      (
        await post(
          snsNotification(bounce(address), {
            Timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          }),
        ).expect(400)
      ).body.code,
    ).toBe('sns_stale');
    expect(
      (
        await post(
          snsNotification(bounce(address), {
            SigningCertURL: 'https://evil.example/c.pem',
          }),
        ).expect(401)
      ).body.code,
    ).toBe('sns_certificate_refused');
    // The JSON parser's path (a sender that sets application/json) works too: the raw bytes are what is verified.
    await node
      .http()
      .post('/v1/webhooks/mail/ses')
      .set('Content-Type', 'application/json')
      .send(snsNotification({ eventType: 'Open' }))
      .expect(200)
      .expect((res) => expect(res.body.kind).toBe('ignored'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (
        await node
          .admin()
          .get(`/v1/mail/suppressions?address=${address}`)
          .expect(200)
      ).body.items,
    ).toEqual([]);

    const subscribe =
      'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t';
    const confirmation = snsNotification('You have chosen to subscribe', {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: subscribe,
      Token: 't',
      Subject: undefined,
    });
    expect((await post(confirmation).expect(200)).body).toEqual({
      received: true,
      kind: 'handshake',
      events: 0,
    });
    expect(gateway.confirmed).toEqual([subscribe]);
  });

  it('keeps mail from suppressed addresses: everything from a bounced one, all but essential mail from one that complained', async () => {
    const bounced = await person();
    const complained = await person();
    await post(snsNotification(bounce(bounced.email))).expect(200);
    await post(snsNotification(complaint(complained.email))).expect(200);
    await entry(bounced.email);
    await entry(complained.email);

    const mailQueue = node.app.get(MailQueue);
    const notify = (to: string) =>
      mailQueue.send(NotificationMail, {
        to,
        data: { name: 'Ada', title: 'Hello', body: 'World', link: null },
      });
    await notify(bounced.email);
    await notify(complained.email);
    expect(
      await entry(bounced.email, (row) => row.skipped === 1),
    ).toBeDefined();
    expect(
      await entry(complained.email, (row) => row.skipped === 1),
    ).toBeDefined();
    expect(node.mailbox.find({ to: bounced.email })).toBeUndefined();
    expect(node.mailbox.find({ to: complained.email })).toBeUndefined();

    // "Forgot my password": asked for by the person, so it reaches the one who complained.
    for (const who of [bounced, complained]) {
      await node
        .http()
        .post('/v1/auth/password/forgot')
        .send({ email: who.email })
        .expect(202);
    }
    // (A queued mail arrives at the transport without its class: matched by subject.)
    await node.waitForMail({ to: complained.email, subject: /password/i });
    expect(
      await entry(bounced.email, (row) => row.skipped === 2),
    ).toBeDefined();
    expect(node.mailbox.find({ to: bounced.email })).toBeUndefined();

    // A mail to a suppressed and a fine recipient at once goes to the fine one alone.
    const fine = `fine-${randomUUID().slice(0, 6)}@example.com`;
    await mailQueue.send(NotificationMail, {
      to: [bounced.email, fine],
      data: { name: 'Both', title: 'Hello', body: 'World', link: null },
    });
    const partial = await node.waitForMail({ to: fine });
    expect(partial.to.map((r) => r.address)).toEqual([fine]);
  });

  it('lets essential mail through a soft-bounce suppression, which expires after MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS', async () => {
    // An attacker fires sign-in-link requests while the victim's mailbox is
    // full: the address gets suppressed as soft_bounce. Account recovery
    // must still work (the mailbox exists), and the entry must not last.
    const victim = await person();
    await post(snsNotification(bounce(victim.email, 'Transient'))).expect(200);
    await post(snsNotification(bounce(victim.email, 'Transient'))).expect(200);
    const suppressed = await entry(
      victim.email,
      (row) => row.suppressedAt !== null,
    );
    expect(suppressed).toMatchObject({ reason: 'soft_bounce', softBounces: 2 });

    const mailQueue = node.app.get(MailQueue);
    await mailQueue.send(NotificationMail, {
      to: victim.email,
      data: { name: 'V', title: 'Not essential', body: 'x', link: null },
    });
    expect(await entry(victim.email, (row) => row.skipped === 1)).toBeDefined();
    expect(node.mailbox.find({ to: victim.email })).toBeUndefined();
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: victim.email })
      .expect(202);
    await node.waitForMail({ to: victim.email, subject: /password/i });

    // 73 hours later (the row backdated): the suppression has expired; the
    // next mail goes out and the entry is watched-only again.
    const db = node.app.get<Database>(getDrizzleToken());
    await db
      .update(mailSuppressions)
      .set({ suppressedAt: new Date(Date.now() - 73 * 3_600_000) })
      .where(eq(mailSuppressions.id, suppressed!.id));
    await mailQueue.send(NotificationMail, {
      to: victim.email,
      data: { name: 'V', title: 'After expiry', body: 'x', link: null },
    });
    await node.waitForMail({ to: victim.email, subject: 'After expiry' });
    expect(
      await entry(victim.email, (row) => row.suppressedAt === null),
    ).toMatchObject({
      reason: 'soft_bounce',
      softBounces: 0,
      skipped: 1,
    });
    // A soft bounce long after the last one starts the count over.
    await db
      .update(mailSuppressions)
      .set({ lastSeenAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(mailSuppressions.id, suppressed!.id));
    await post(snsNotification(bounce(victim.email, 'Transient'))).expect(200);
    expect(await entry(victim.email, (row) => row.events === 3)).toMatchObject({
      softBounces: 1,
      suppressedAt: null,
    });
  });

  it('lets administrators add and remove entries, audited; others may not', async () => {
    const viewer = await person(['viewer']);
    const agent = await node.signIn(viewer.email, viewer.password);
    await agent.get('/v1/mail/suppressions').expect(403);
    await agent
      .post('/v1/mail/suppressions')
      .send({ address: 'x@example.com' })
      .expect(403);

    const address = `Manual-${randomUUID().slice(0, 6)}@Example.com`;
    const bad = await node
      .admin()
      .post('/v1/mail/suppressions')
      .send({ address: 'nope' })
      .expect(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'address',
    ]);
    const created = await node
      .admin()
      .post('/v1/mail/suppressions')
      .send({ address, note: 'Asked us to stop by phone' })
      .expect(201);
    expect(created.body).toMatchObject({
      address: address.toLowerCase(),
      reason: 'manual',
      source: 'manual',
      note: 'Asked us to stop by phone',
      events: 0,
    });
    expect(created.body.suppressedAt).not.toBeNull();
    expect(
      (
        await node
          .admin()
          .post('/v1/mail/suppressions')
          .send({ address: address.toUpperCase() })
          .expect(409)
      ).body.code,
    ).toBe('conflict');

    // Essential mail doesn't get past a manual entry.
    await node.app.get(MailQueue).send(ResetPasswordMail, {
      to: address,
      data: {
        name: 'M',
        url: 'https://web.example.com/x',
        expiresAt: new Date(),
        timezone: null,
      },
    });
    expect(await entry(address, (row) => row.skipped === 1)).toBeDefined();
    expect(node.mailbox.find({ to: address.toLowerCase() })).toBeUndefined();

    const list = await node
      .admin()
      .get('/v1/mail/suppressions?reason=manual&sort=-createdAt')
      .expect(200);
    expect(list.body.items.map((row: { id: string }) => row.id)).toContain(
      created.body.id,
    );
    await agent.delete(`/v1/mail/suppressions/${created.body.id}`).expect(403);
    await node
      .admin()
      .delete(`/v1/mail/suppressions/${created.body.id}`)
      .expect(204);
    await node
      .admin()
      .delete(`/v1/mail/suppressions/${created.body.id}`)
      .expect(404);
    await node
      .admin()
      .get(`/v1/mail/suppressions/${created.body.id}`)
      .expect(404);

    // Removed: the mail goes out again.
    await node.app.get(MailQueue).send(NotificationMail, {
      to: address,
      data: { name: 'M', title: 'Back', body: 'again', link: null },
    });
    await node.waitForMail({ to: address.toLowerCase(), subject: 'Back' });

    for (const action of [
      'mailSuppression.created',
      'mailSuppression.deleted',
    ]) {
      const audit = await node
        .admin()
        .get(`/v1/access/audit?action=${action}&targetId=${created.body.id}`)
        .expect(200);
      expect(audit.body.items).toHaveLength(1);
      expect(audit.body.items[0].actorLabel).toBe(process.env.ADMIN_EMAIL);
    }
  });

  it('exports a person’s entries with their data, erases them with the account, and prunes old events', async () => {
    const ada = await person(['editor']);
    const agent = await node.signIn(ada.email, ada.password);
    await post(snsNotification(complaint(ada.email))).expect(200);
    await entry(ada.email);

    const started = await agent.post('/v1/account/export').send({}).expect(202);
    let status;
    for (let tries = 0; tries < 100; tries++) {
      status = (
        await agent.get(`/v1/data/transfers/${started.body.id}`).expect(200)
      ).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const { pathname, search } = new URL(status.result.url);
    const file = (
      await node
        .http()
        .get(pathname + search)
        .expect(200)
    ).body as {
      kind: string;
      data: Record<string, unknown>;
    }[];
    const mine = file.filter((row) => row.kind === 'mailSuppression');
    expect(mine.map((row) => row.data.reason ?? row.data.type).sort()).toEqual([
      'complaint',
      'complaint',
    ]);
    expect(mine.every((row) => row.data.address === ada.email)).toBe(true);

    await agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    const job = node.app.get(AccountDeletionJob);
    expect(await job.run(new Date(Date.now() + 15 * 86_400_000))).toBe(1);
    expect(
      (
        await node
          .admin()
          .get(`/v1/mail/suppressions?address=${ada.email}`)
          .expect(200)
      ).body.items,
    ).toEqual([]);

    // The events of everyone else stay until MAIL_EVENTS_RETENTION_DAYS pass.
    const retention = node.app.get(MailEventsRetentionJob);
    expect(await retention.run(new Date())).toBe(0);
    expect(
      await retention.run(new Date(Date.now() + 91 * 86_400_000)),
    ).toBeGreaterThan(0);
  });

  it('declares the intake job in the catalog, with no permissions', async () => {
    const catalog = await node.admin().get('/v1/access/catalog').expect(200);
    const jobs = catalog.body.systemJobs as {
      key: string;
      permissions: unknown[];
    }[];
    expect(jobs.find((job) => job.key === 'mail-intake')).toMatchObject({
      permissions: [],
    });
    expect(
      jobs.find((job) => job.key === 'mail-events-retention'),
    ).toBeDefined();
    expect(
      (catalog.body.subjects as { subject: string }[]).map((s) => s.subject),
    ).toContain('MailSuppression');
  });
});
