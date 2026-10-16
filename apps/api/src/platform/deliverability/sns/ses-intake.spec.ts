import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../../platform.env.js';
import { MailEventIntakeRegistry } from '../mail-events.service.js';
import { SesIntake } from './ses-intake.js';
import { sesEvents } from './ses-message.js';
import {
  CERTIFICATE_MAX_BYTES,
  publicKeyOf,
  type SnsGateway,
} from './sns-gateway.js';
import {
  isSnsUrl,
  type SnsMessage,
  snsSignatureValid,
  snsStringToSign,
  snsTimestampFresh,
} from './sns-message.js';

/** A key pair standing in for SNS's: the "certificate" the gateway serves is its public key. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:ses-feedback';
const CERT_URL =
  'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc123.pem';

/** Signs a message as SNS does (version 1: SHA1withRSA; 2: SHA256withRSA). */
function sign(
  fields: Omit<
    SnsMessage,
    'Signature' | 'SignatureVersion' | 'SigningCertURL'
  > &
    Partial<Pick<SnsMessage, 'SignatureVersion' | 'SigningCertURL'>>,
  key = privateKey,
): SnsMessage {
  const message: SnsMessage = {
    SignatureVersion: '1',
    SigningCertURL: CERT_URL,
    Signature: '',
    ...fields,
  };
  message.Signature = createSign(
    message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
  )
    .update(snsStringToSign(message), 'utf8')
    .sign(key, 'base64');
  return message;
}

const bounce = (recipients: string[], bounceType = 'Permanent') =>
  JSON.stringify({
    notificationType: 'Bounce',
    bounce: {
      bounceType,
      bounceSubType: bounceType === 'Permanent' ? 'General' : 'MailboxFull',
      bouncedRecipients: recipients.map((emailAddress) => ({
        emailAddress,
        status: '5.1.1',
        diagnosticCode: 'smtp; 550 5.1.1 user unknown',
      })),
      timestamp: '2026-10-16T08:00:00.000Z',
    },
    mail: { timestamp: '2026-10-16T07:59:00.000Z' },
  });

const notification = (message: string, overrides: Partial<SnsMessage> = {}) =>
  sign({
    Type: 'Notification',
    MessageId: 'c6e4b5a0-1111-4e2a-9b9f-000000000001',
    TopicArn: TOPIC,
    Message: message,
    Timestamp: new Date().toISOString(),
    ...overrides,
  });

/** A gateway that serves the test key and records the URLs it was asked to visit. */
class FakeGateway implements SnsGateway {
  readonly fetched: string[] = [];
  readonly confirmed: string[] = [];
  failCertificate = false;

  async certificate(url: string): Promise<KeyObject> {
    this.fetched.push(url);
    if (this.failCertificate) {
      throw new Error('ECONNRESET');
    }
    return publicKeyOf(publicPem);
  }

  async confirm(url: string) {
    this.confirmed.push(url);
  }
}

function intake(topics: string[] = [TOPIC], { requireV2 = false } = {}) {
  const gateway = new FakeGateway();
  const config = {
    get: (key: keyof PlatformEnv) =>
      key === 'SES_SNS_TOPIC_ARNS'
        ? topics
        : key === 'SES_SNS_REQUIRE_SIGNATURE_V2'
          ? requireV2
          : undefined,
  } as unknown as ConfigService<PlatformEnv, true>;
  const registry = new MailEventIntakeRegistry();
  const ses = new SesIntake(gateway, config, registry);
  const receive = (body: unknown) =>
    ses.receive({
      rawBody: Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body),
      ),
      headers: {},
    });
  return { ses, gateway, registry, receive };
}

describe('SNS message verification', () => {
  it('accepts only https URLs on SNS hosts, without credentials or a port', () => {
    expect(isSnsUrl(CERT_URL, { certificate: true })).toBe(true);
    expect(isSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem')).toBe(
      true,
    );
    for (const bad of [
      'http://sns.eu-central-1.amazonaws.com/x.pem',
      'https://sns.eu-central-1.amazonaws.com.evil.example/x.pem',
      'https://evil.example/sns.eu-central-1.amazonaws.com/x.pem',
      'https://sns.eu-central-1.amazonaws.com@evil.example/x.pem',
      'https://user:pw@sns.eu-central-1.amazonaws.com/x.pem',
      'https://sns.eu-central-1.amazonaws.com:8443/x.pem',
      'https://s3.eu-central-1.amazonaws.com/x.pem',
      'not a url',
    ]) {
      expect(isSnsUrl(bad), bad).toBe(false);
    }
    // A certificate must be SNS's own file name, not any .pem on the host.
    for (const bad of [
      'https://sns.eu-central-1.amazonaws.com/x.pem',
      'https://sns.eu-central-1.amazonaws.com/a/SimpleNotificationService-abc.pem',
      'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem/../other.pem',
      'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-.pem',
      'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem?x=1',
    ]) {
      expect(isSnsUrl(bad, { certificate: true }), bad).toBe(false);
    }
    // A certificate must be a .pem; a SubscribeURL need not.
    expect(
      isSnsUrl('https://sns.eu-central-1.amazonaws.com/?Action=Confirm', {
        certificate: true,
      }),
    ).toBe(false);
    expect(
      isSnsUrl('https://sns.eu-central-1.amazonaws.com/?Action=Confirm'),
    ).toBe(true);
  });

  it('builds the string to sign in the documented order, with the optional fields only when present', () => {
    const message = notification('hello', { Subject: 'Amazon SES Bounce' });
    expect(snsStringToSign(message)).toBe(
      `Message\nhello\nMessageId\n${message.MessageId}\nSubject\nAmazon SES Bounce\nTimestamp\n${message.Timestamp}\nTopicArn\n${TOPIC}\nType\nNotification\n`,
    );
    const confirmation = sign({
      Type: 'SubscriptionConfirmation',
      MessageId: 'm',
      TopicArn: TOPIC,
      Message: 'confirm',
      Timestamp: 't',
      SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=X',
      Token: 'tok',
    });
    expect(snsStringToSign(confirmation)).toBe(
      `Message\nconfirm\nMessageId\nm\nSubscribeURL\nhttps://sns.eu-central-1.amazonaws.com/?Action=X\nTimestamp\nt\nToken\ntok\nTopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`,
    );
  });

  it('verifies signature versions 1 and 2, and refuses a tampered or foreign signature', () => {
    const v1 = notification(bounce(['a@example.com']));
    const v2 = notification(bounce(['a@example.com']), {
      SignatureVersion: '2',
    });
    expect(snsSignatureValid(v1, publicKey)).toBe(true);
    expect(snsSignatureValid(v2, publicKey)).toBe(true);
    // The body changed after signing.
    expect(
      snsSignatureValid(
        { ...v1, Message: bounce(['b@example.com']) },
        publicKey,
      ),
    ).toBe(false);
    // Signed with someone else's key.
    expect(
      snsSignatureValid(
        notification(bounce(['a@example.com'])),
        other.publicKey,
      ),
    ).toBe(false);
    // A version swap (the hash differs) and junk.
    expect(snsSignatureValid({ ...v1, SignatureVersion: '2' }, publicKey)).toBe(
      false,
    );
    expect(snsSignatureValid({ ...v1, Signature: '!!!' }, publicKey)).toBe(
      false,
    );
  });
});

describe('SNS message freshness', () => {
  it('accepts the last hour and a few minutes of skew, nothing else', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    expect(snsTimestampFresh(at(0), now)).toBe(true);
    expect(snsTimestampFresh(at(-59 * 60_000), now)).toBe(true);
    expect(snsTimestampFresh(at(4 * 60_000), now)).toBe(true);
    expect(snsTimestampFresh(at(-61 * 60_000), now)).toBe(false);
    expect(snsTimestampFresh(at(6 * 60_000), now)).toBe(false);
    expect(snsTimestampFresh('yesterday', now)).toBe(false);
    expect(snsTimestampFresh('', now)).toBe(false);
  });
});

describe('SNS signing certificates', () => {
  const certificate = readFileSync(
    join(import.meta.dirname, 'fixtures/valid-certificate.pem'),
    'utf8',
  );

  it('reads the key of a certificate that is valid now, and refuses one that is not', () => {
    expect(publicKeyOf(certificate).type).toBe('public');
    expect(publicKeyOf(certificate, new Date('2030-01-01')).type).toBe(
      'public',
    );
    expect(() => publicKeyOf(certificate, new Date('1999-01-01'))).toThrow(
      /not valid now/,
    );
    expect(() => publicKeyOf(certificate, new Date('2300-01-01'))).toThrow(
      /not valid now/,
    );
  });

  it('refuses a body larger than SNS ever serves', () => {
    const padded = certificate + '\n'.repeat(CERTIFICATE_MAX_BYTES);
    expect(() => publicKeyOf(padded)).toThrow(/larger than/);
  });
});

describe('SES message parsing', () => {
  it('turns bounces, complaints and deliveries into events, by type', () => {
    expect(sesEvents(bounce(['A@Example.com']))).toEqual([
      {
        type: 'hard_bounce',
        address: 'A@Example.com',
        occurredAt: '2026-10-16T08:00:00.000Z',
        detail: 'Permanent/General: 5.1.1: smtp; 550 5.1.1 user unknown',
      },
    ]);
    expect(sesEvents(bounce(['a@example.com'], 'Transient'))[0]).toMatchObject({
      type: 'soft_bounce',
      detail: expect.stringContaining('Transient'),
    });
    expect(sesEvents(bounce(['a@example.com'], 'Undetermined'))[0]?.type).toBe(
      'soft_bounce',
    );
    expect(
      sesEvents(
        JSON.stringify({
          eventType: 'Complaint',
          complaint: {
            complainedRecipients: [{ emailAddress: 'c@example.com' }],
            complaintFeedbackType: 'abuse',
          },
          mail: { timestamp: '2026-10-16T09:00:00.000Z' },
        }),
      ),
    ).toEqual([
      {
        type: 'complaint',
        address: 'c@example.com',
        occurredAt: '2026-10-16T09:00:00.000Z',
        detail: 'abuse',
      },
    ]);
    expect(
      sesEvents(
        JSON.stringify({
          notificationType: 'Delivery',
          delivery: {
            recipients: ['d@example.com'],
            timestamp: '2026-10-16T09:00:00.000Z',
          },
        }),
      ),
    ).toEqual([
      {
        type: 'delivery',
        address: 'd@example.com',
        occurredAt: '2026-10-16T09:00:00.000Z',
      },
    ]);
  });

  it('gives no events for other SES types, and undefined for what is not SES', () => {
    expect(sesEvents(JSON.stringify({ eventType: 'Open' }))).toEqual([]);
    expect(sesEvents('Successfully validated SNS topic')).toBeUndefined();
    expect(sesEvents(JSON.stringify({ hello: 'world' }))).toBeUndefined();
  });
});

describe('SesIntake', () => {
  it('registers itself as "ses"', () => {
    const { ses, registry } = intake();
    expect(registry.find('ses')).toBe(ses);
  });

  it('queues the events of a signed notification from an allowed topic', async () => {
    const { receive, gateway } = intake();
    const message = notification(bounce(['Ada@Example.com']));
    await expect(receive(message)).resolves.toEqual({
      kind: 'events',
      id: message.MessageId,
      events: [expect.objectContaining({ type: 'hard_bounce' })],
    });
    expect(gateway.fetched).toEqual([CERT_URL]);
  });

  it('refuses what is not an SNS message (400)', async () => {
    const { receive } = intake();
    await expect(receive('not json')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(receive({ Type: 'Notification' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      receive({ ...notification('x'), Type: 'Something' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      receive({ ...notification('x'), SignatureVersion: '3' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a message older than an hour or dated ahead (400 sns_stale), before any fetch', async () => {
    const { receive, gateway } = intake();
    for (const Timestamp of [
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
      new Date(Date.now() + 10 * 60_000).toISOString(),
      'not a date',
    ]) {
      await expect(
        receive(notification(bounce(['a@example.com']), { Timestamp })),
      ).rejects.toMatchObject({ status: 400, response: { code: 'sns_stale' } });
    }
    expect(gateway.fetched).toEqual([]);
  });

  it('refuses SignatureVersion 1 when SES_SNS_REQUIRE_SIGNATURE_V2 is on', async () => {
    const { receive, gateway } = intake([TOPIC], { requireV2: true });
    await expect(
      receive(notification(bounce(['a@example.com']))),
    ).rejects.toMatchObject({
      status: 401,
      response: { code: 'sns_signature_version_refused' },
    });
    expect(gateway.fetched).toEqual([]);
    await expect(
      receive(
        notification(bounce(['a@example.com']), { SignatureVersion: '2' }),
      ),
    ).resolves.toMatchObject({ kind: 'events' });
  });

  it('never fetches a certificate from anywhere but an SNS host (401)', async () => {
    const { receive, gateway } = intake();
    for (const url of [
      'https://evil.example/cert.pem',
      'http://sns.eu-central-1.amazonaws.com/cert.pem',
      'https://sns.eu-central-1.amazonaws.com.evil.example/cert.pem',
      'https://sns.eu-central-1.amazonaws.com/cert.txt',
    ]) {
      const message = notification(bounce(['a@example.com']), {
        SigningCertURL: url,
      });
      await expect(receive(message), url).rejects.toMatchObject({
        status: 401,
        response: { code: 'sns_certificate_refused' },
      });
    }
    expect(gateway.fetched).toEqual([]);
  });

  it('refuses a topic that is not configured (403), before fetching anything', async () => {
    const { receive, gateway } = intake();
    const message = notification(bounce(['a@example.com']), {
      TopicArn: 'arn:aws:sns:eu-central-1:123456789012:someone-elses',
    });
    await expect(receive(message)).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.fetched).toEqual([]);
    // No topics configured: everything is refused.
    const none = intake([]);
    await expect(
      none.receive(notification(bounce(['a@example.com']))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a bad signature (401) and a certificate that cannot be fetched (503)', async () => {
    const { receive, gateway } = intake();
    const forged = { ...notification(bounce(['a@example.com'])) };
    forged.Message = bounce(['victim@example.com']);
    await expect(receive(forged)).rejects.toMatchObject({
      status: 401,
      response: { code: 'sns_signature_invalid' },
    });
    const foreign = sign(
      {
        Type: 'Notification',
        MessageId: 'm2',
        TopicArn: TOPIC,
        Message: bounce(['a@example.com']),
        Timestamp: new Date().toISOString(),
      },
      other.privateKey,
    );
    await expect(receive(foreign)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    gateway.failCertificate = true;
    await expect(
      receive(notification(bounce(['a@example.com']))),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('confirms a subscription of an allowed topic through an SNS URL only', async () => {
    const { receive, gateway } = intake();
    const confirmation = (SubscribeURL: string, TopicArn = TOPIC) =>
      sign({
        Type: 'SubscriptionConfirmation',
        MessageId: 'sub-1',
        TopicArn,
        Message: 'You have chosen to subscribe…',
        Timestamp: new Date().toISOString(),
        SubscribeURL,
        Token: 'abc',
      });
    const good =
      'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc';
    await expect(receive(confirmation(good))).resolves.toEqual({
      kind: 'handshake',
      detail: 'subscription-confirmed',
    });
    expect(gateway.confirmed).toEqual([good]);

    await expect(
      receive(confirmation('https://evil.example/?Action=ConfirmSubscription')),
    ).rejects.toMatchObject({
      response: { code: 'sns_subscribe_url_refused' },
    });
    await expect(
      receive(confirmation(good, 'arn:aws:sns:eu-central-1:1:other')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.confirmed).toEqual([good]);
  });

  it('ignores an unsubscribe confirmation without visiting anything, and non-SES notifications', async () => {
    const { receive, gateway } = intake();
    const unsubscribe = sign({
      Type: 'UnsubscribeConfirmation',
      MessageId: 'unsub-1',
      TopicArn: TOPIC,
      Message: 'You have chosen to deactivate…',
      Timestamp: new Date().toISOString(),
      SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=Confirm',
      Token: 'abc',
    });
    await expect(receive(unsubscribe)).resolves.toEqual({
      kind: 'ignored',
      detail: 'unsubscribe-confirmation',
    });
    expect(gateway.confirmed).toEqual([]);
    await expect(
      receive(notification('Successfully validated SNS topic')),
    ).resolves.toEqual({ kind: 'ignored', detail: 'not-an-ses-message' });
    await expect(
      receive(notification(JSON.stringify({ eventType: 'Open' }))),
    ).resolves.toEqual({ kind: 'ignored', detail: 'no-recipients' });
  });
});
