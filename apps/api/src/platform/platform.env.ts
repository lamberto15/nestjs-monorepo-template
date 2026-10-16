import { z } from 'zod';
import {
  baseUrl,
  flag,
  list,
  optional,
  pathWithDefault,
  secret,
} from '../core/config/env.helpers.js';

/** What attachments may be by default: images, PDF, Office documents, text, zip. */
const DEFAULT_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
];

/** The environment of the platform: workers, keys at rest, integrations. */
export const platformEnv = z.object({
  /** Seal stored idempotent responses: base64 keys, newest first. Unset: created once, kept in the database. */
  IDEMPOTENCY_KEYS: secret(optional()),
  /** Seal webhook endpoint secrets at rest: base64 keys, newest first. */
  WEBHOOKS_ENCRYPTION_KEYS: secret(optional()),
  /** Lets webhook endpoints be http://127.0.0.1 (development, tests). */
  WEBHOOKS_ALLOW_LOOPBACK: flag('off'),
  /** Background workers: off in tests, which drive them with runOnce(). */
  OUTBOX_RELAY: flag('on'),
  WEBHOOKS_WORKER: flag('on'),

  /** The hour (0–23, in each user's time zone) daily notification digests are mailed. */
  NOTIFICATIONS_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  /** Read notifications older than this many days are deleted every night. */
  NOTIFICATIONS_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  /** Any notification older than this many days is deleted, read or not. */
  NOTIFICATIONS_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(365),
  /** A bulk run of up to this many ids answers in the request; more (and every filter) is a queue job. */
  BULK_SYNC_LIMIT: z.coerce.number().int().min(0).max(500).default(100),
  /** How long a user has to cancel their account's deletion before it is carried out. */
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(0).default(14),
  /** API clients' daily usage (platform/usage) older than this many days is deleted every night. */
  USAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(400),
  /** Record revisions (platform/revisions) older than this many days are deleted every night; each record's latest stays. */
  REVISIONS_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  /** How long a scheduled report's mailed download link works: `30m`, `24h`, `3d` (at most 7 days). In milliseconds once read. */
  REPORT_LINK_TTL: z
    .string()
    .regex(/^\d+(s|m|h|d)$/, 'a duration: 30m, 24h, 3d')
    .default('24h')
    .transform(
      (value) =>
        Number(value.slice(0, -1)) *
        { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
          value.slice(-1) as 's' | 'm' | 'h' | 'd'
        ],
    )
    .refine(
      (ms) => ms >= 60_000 && ms <= 7 * 86_400_000,
      'between 1m and 7d (a signed URL lasts at most 7 days)',
    ),

  /** Fetch the ECB's euro reference rates every working day (platform/money): off for an app without money, and in tests. */
  EXCHANGE_RATES_FETCH: flag('on'),
  /** Where the ECB's eurofxref documents are (eurofxref-daily.xml, eurofxref-hist-90d.xml): a mirror, or a stub in tests. */
  EXCHANGE_RATES_ECB_URL: baseUrl('https://www.ecb.europa.eu/stats/eurofxref'),

  // Email deliverability (platform/deliverability, docs/deliverability.md).
  /**
   * The SNS topics whose notifications `POST /webhooks/mail/ses` accepts
   * (comma-separated ARNs): the ones SES publishes bounces and complaints
   * to. Empty: every notification is refused (403), so the route is inert
   * until the topic is configured.
   */
  SES_SNS_TOPIC_ARNS: list(),
  /** Transient (soft) bounces within MAIL_SOFT_BOUNCE_WINDOW_HOURS before an address is suppressed. */
  MAIL_SOFT_BOUNCE_THRESHOLD: z.coerce.number().int().min(1).max(50).default(3),
  /** Soft bounces count when the previous one is at most this many hours old; older, the count starts over. */
  MAIL_SOFT_BOUNCE_WINDOW_HOURS: z.coerce.number().int().min(1).default(24),
  /** How long a soft-bounce suppression lasts; then the address is only watched again (a full mailbox empties). */
  MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(72),
  /** Refuse SNS messages signed with SignatureVersion 1 (SHA1): set the topic's attribute to 2 first. */
  SES_SNS_REQUIRE_SIGNATURE_V2: flag('off'),
  /** Bounce, complaint and delivery events (the trail behind the suppression list) older than this many days are deleted every night. */
  MAIL_EVENTS_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

  /** Files attached to records (platform/attachments): the largest, in MB. */
  ATTACHMENT_MAX_MB: z.coerce.number().int().min(1).max(5000).default(25),
  /** The types attachments may have, detected from their bytes: comma-separated MIME types. */
  ATTACHMENT_ALLOWED_TYPES: list().transform((types) =>
    types.length > 0 ? types : DEFAULT_ATTACHMENT_TYPES,
  ),

  /**
   * PDF documents (platform/documents): Gotenberg's URL, `http://gotenberg:3000`
   * in Compose. Unset: documents are off, and asking for one answers 503
   * `documents_unavailable`; nothing else needs it.
   */
  GOTENBERG_URL: baseUrl(),
  /** One render's limit, in milliseconds; a render that takes longer is tried again. */
  GOTENBERG_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  /** Tries per document, the first included (exponential backoff from 1 s), before it fails. */
  DOCUMENTS_RENDER_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /** Where files go: `local` (STORAGE_ROOT), `s3` (any S3-compatible store), `memory` (tests). */
  STORAGE_DRIVER: z.enum(['local', 's3', 'memory']).default('local'),
  STORAGE_ROOT: pathWithDefault('.data/storage'),
  /** Sign the app-served file URLs (local disk): 32+ characters, newest first. Unset: created once. */
  STORAGE_SIGNING_KEYS: secret(optional()),
  S3_BUCKET: optional(),
  /** `auto` for Cloudflare R2. Default: AWS_REGION. */
  S3_REGION: optional(),
  /** S3-compatible endpoints: https://<account>.r2.cloudflarestorage.com, http://minio:9000… */
  S3_ENDPOINT: optional(),
  /** MinIO and most self-hosted stores. */
  S3_FORCE_PATH_STYLE: flag('off'),
});

export type PlatformEnv = z.output<typeof platformEnv>;
