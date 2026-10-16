import { createVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/**
 * An SNS HTTP(S) notification, as Amazon SNS POSTs it (the body is JSON,
 * sent as text/plain): https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html
 *
 * Custom code: no @nestjs package speaks SNS. @nestjs/webhooks verifies
 * HMAC schemes keyed on a shared secret, synchronously; SNS signs with
 * RSA and a certificate the message points at, which is fetched (and
 * cached) first, so its `@VerifyWebhook()` can't carry it. Only the
 * format and the signature are here: the queue, the inbox and the rest
 * stay the platform's.
 */
export const snsMessageSchema = z.looseObject({
  Type: z.enum([
    'Notification',
    'SubscriptionConfirmation',
    'UnsubscribeConfirmation',
  ]),
  MessageId: z.string().min(1).max(255),
  TopicArn: z.string().min(1).max(1024),
  Message: z.string(),
  Timestamp: z.string().min(1),
  /** `1`: SHA1withRSA (the default); `2`: SHA256withRSA (the topic's `SignatureVersion` attribute). */
  SignatureVersion: z.enum(['1', '2']),
  Signature: z.string().min(1),
  SigningCertURL: z.string().min(1),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
});
export type SnsMessage = z.infer<typeof snsMessageSchema>;

/**
 * SNS's own hosts: `sns.<region>.amazonaws.com` (and the China partition's
 * `.amazonaws.com.cn`), over https, without credentials or a port. Checked
 * before anything is fetched: the message names its certificate's URL, so
 * a forged message could otherwise point at a certificate of the forger's.
 */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/;
/** The certificates SNS serves: `/SimpleNotificationService-<id>.pem`, nothing else on the host. */
const SNS_CERTIFICATE_PATH = /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/;

/** Whether `url` is an https URL on an SNS host (`.pem` required for a certificate). */
export function isSnsUrl(
  url: string,
  { certificate = false }: { certificate?: boolean } = {},
) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    SNS_HOST.test(parsed.hostname) &&
    (!certificate ||
      (SNS_CERTIFICATE_PATH.test(parsed.pathname) &&
        parsed.search === '' &&
        parsed.hash === ''))
  );
}

/** How old a message may be; SNS retries an HTTP endpoint for about an hour. */
export const SNS_MAX_AGE_MS = 3_600_000;
/** How far ahead a message's Timestamp may be (clock skew). */
export const SNS_MAX_SKEW_MS = 5 * 60_000;

/**
 * Whether the signed `Timestamp` is recent: not older than an hour, not
 * more than a few minutes ahead. A captured message can't be replayed
 * once the events table has forgotten it (MAIL_EVENTS_RETENTION_DAYS).
 */
export function snsTimestampFresh(timestamp: string, now = new Date()) {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) {
    return false;
  }
  const age = now.getTime() - at;
  return age <= SNS_MAX_AGE_MS && age >= -SNS_MAX_SKEW_MS;
}

/**
 * The string SNS signed: `Name\nValue\n` for the fields of the type, in
 * their fixed order, the optional ones only when present.
 */
export function snsStringToSign(message: SnsMessage) {
  const fields: (keyof SnsMessage)[] =
    message.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : [
          'Message',
          'MessageId',
          'SubscribeURL',
          'Timestamp',
          'Token',
          'TopicArn',
          'Type',
        ];
  return fields
    .filter((field) => typeof message[field] === 'string')
    .map((field) => `${field}\n${message[field] as string}\n`)
    .join('');
}

/** Whether `message.Signature` is the certificate's signature of the message. False for malformed base64. */
export function snsSignatureValid(message: SnsMessage, publicKey: KeyObject) {
  try {
    return createVerify(
      message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
    )
      .update(snsStringToSign(message), 'utf8')
      .verify(publicKey, message.Signature, 'base64');
  } catch {
    return false;
  }
}
