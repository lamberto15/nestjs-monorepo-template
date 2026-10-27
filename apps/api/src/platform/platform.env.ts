import { z } from 'zod';
import {
  baseUrl,
  choice,
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
  /**
   * `required`: the routes marked @Idempotent() refuse a request without an
   * Idempotency-Key (400). `optional`: a key is honoured when sent, never demanded.
   */
  IDEMPOTENCY: choice(['required', 'optional'], 'required'),
  /** Seal stored idempotent responses: base64 keys, newest first. Unset: created once, kept in the database. */
  IDEMPOTENCY_KEYS: secret(optional()),
  /** Seal webhook endpoint secrets at rest: base64 keys, newest first. */
  WEBHOOKS_ENCRYPTION_KEYS: secret(optional()),
  /** Lets webhook endpoints be http://127.0.0.1 (development, tests). */
  WEBHOOKS_ALLOW_LOOPBACK: flag('off'),
  /** Background workers: off in tests, which drive them with runOnce(). */
  OUTBOX_RELAY: flag('on'),
  WEBHOOKS_WORKER: flag('on'),

  /**
   * Worker concurrency (docs/configuration.md, "Worker concurrency"): what
   * one process runs at once. Each slot can hold a database connection
   * (DATABASE_POOL_MAX), so a small worker turns these down.
   */
  /** Outbox events the relay claims per poll. */
  OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).default(100),
  /** Outbox events the relay dispatches at once. */
  OUTBOX_RELAY_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  /** Workflow instances this process executes at once. */
  WORKFLOW_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  /** Jobs each queue's worker runs at once (the mail and SSO queues: core and iam). */
  QUEUE_CONCURRENCY_MESSAGING: z.coerce.number().int().min(1).default(5),
  QUEUE_CONCURRENCY_ATTACHMENT_SCAN: z.coerce.number().int().min(1).default(4),
  QUEUE_CONCURRENCY_DATA_TRANSFERS: z.coerce.number().int().min(1).default(2),
  QUEUE_CONCURRENCY_BULK: z.coerce.number().int().min(1).default(2),
  QUEUE_CONCURRENCY_DOCUMENTS: z.coerce.number().int().min(1).default(2),
  QUEUE_CONCURRENCY_AI: z.coerce.number().int().min(1).default(2),
  QUEUE_CONCURRENCY_MAIL_EVENTS: z.coerce.number().int().min(1).default(2),
  QUEUE_CONCURRENCY_RETENTION: z.coerce.number().int().min(1).default(1),
  QUEUE_CONCURRENCY_REENCRYPTION: z.coerce.number().int().min(1).default(1),
  QUEUE_CONCURRENCY_ATTACHMENT_IMAGES: z.coerce
    .number()
    .int()
    .min(1)
    .default(1),

  /**
   * Deployment switches (docs/configuration.md): platform modules a project
   * may not need. `off` leaves the module's routes, workers and jobs out.
   */
  /** Outgoing webhooks: the endpoint and delivery API and the delivery worker. */
  WEBHOOKS: flag('on'),
  /** Scheduled reports: the API and the hourly runner. */
  REPORTS: flag('on'),
  /** API clients' usage metering, daily quotas, the usage API and its roll-up. */
  USAGE: flag('on'),
  /** The socket.io gateway at /realtime and its Redis adapter. */
  REALTIME: flag('on'),

  /**
   * Forces the app mode (docs/settings.md, "Maintenance and read-only
   * mode"): `normal`, `read-only` or `maintenance`. Unset: the operators'
   * `platform.mode` setting decides. Set, it wins and the setting can't be
   * changed (`setting_not_allowed`).
   */
  APP_MODE: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['normal', 'read-only', 'maintenance']).optional(),
  ),

  /** The hour (0–23, in each user's time zone) daily notification digests are mailed. */
  NOTIFICATIONS_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  /**
   * A mailbox for `List-Unsubscribe` (`mailto:`), added to notification mail
   * beside the https link (RFC 8058). Empty: no mailto; the https one-click
   * link is what Gmail and Yahoo require. Nothing in the app reads this
   * mailbox: set it only when your mail setup does.
   */
  MAIL_UNSUBSCRIBE_MAILTO: optional(),
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
  /**
   * Platform analytics (platform/analytics): a count below this many is
   * withheld from the aggregates the reporting role reads (small-group
   * suppression, docs/tenancy.md, "Platform analytics").
   */
  ANALYTICS_MIN_GROUP_SIZE: z.coerce.number().int().min(2).default(10),
  /**
   * Outgoing webhook deliveries (platform/webhooks) that finished (succeeded, or failed
   * for good) more than this many days ago are deleted every night, with their attempt log
   * and recorded requests; one still being retried stays.
   */
  WEBHOOKS_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
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

  // Push and SMS (platform/messaging, docs/notifications.md, "Push and SMS").
  // Both providers are off until configured: nothing leaves the deployment.
  /** SMS provider: `off`, `twilio`, or `memory` (tests: keeps what it would send). */
  SMS_PROVIDER: choice(['off', 'twilio', 'memory'], 'off'),
  TWILIO_ACCOUNT_SID: optional(),
  TWILIO_AUTH_TOKEN: secret(optional()),
  /** The sending number (E.164) or a Messaging Service SID (`MG…`). */
  TWILIO_FROM: optional(),
  /** The URL Twilio posts inbound messages to, when it is not APP_URL + the route (a proxy rewrites it): it is part of what Twilio signs. */
  TWILIO_WEBHOOK_URL: optional(),
  /** Twilio's REST API (a stub on loopback in tests). */
  TWILIO_API_URL: baseUrl('https://api.twilio.com'),
  /**
   * Push providers, comma-separated: `off` (default), `web-push` (VAPID),
   * `apns` (iOS), `fcm` (Android), `memory` (tests). `web-push,apns,fcm`
   * serves all three platforms; each device goes to the provider of its platform.
   */
  PUSH_PROVIDER: list().pipe(
    z
      .array(z.enum(['off', 'web-push', 'apns', 'fcm', 'memory']))
      .transform((values) => values.filter((value) => value !== 'off')),
  ),
  WEB_PUSH_VAPID_PUBLIC_KEY: optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: secret(optional()),
  /** The VAPID contact: `mailto:ops@example.com` or an https URL. */
  WEB_PUSH_SUBJECT: optional(),
  /** APNs (token-based auth): the .p8 key's id and contents (PEM; `\n` for newlines), the Apple team id, the app's bundle id. */
  APNS_KEY_ID: optional(),
  APNS_PRIVATE_KEY: secret(optional()),
  APNS_TEAM_ID: optional(),
  APNS_BUNDLE_ID: optional(),
  /** APNs' host: production by default; `https://api.sandbox.push.apple.com` for development builds (a stub on loopback in tests). */
  APNS_API_URL: baseUrl('https://api.push.apple.com'),
  /** FCM (HTTP v1): the Firebase project id and the service account's `client_email` and `private_key` (PEM; `\n` for newlines). */
  FCM_PROJECT_ID: optional(),
  FCM_CLIENT_EMAIL: optional(),
  FCM_PRIVATE_KEY: secret(optional()),
  FCM_API_URL: baseUrl('https://fcm.googleapis.com'),
  /** Google's OAuth2 token endpoint (a stub on loopback in tests). */
  FCM_TOKEN_URL: baseUrl('https://oauth2.googleapis.com/token'),
  /**
   * Toll fraud: the destination country-calling-code prefixes SMS may go to
   * (`+1,+44,+49`). Empty: none, so no SMS is sent until the deployment
   * names the countries it serves.
   */
  SMS_ALLOWED_PREFIXES: list(),
  /** SMS a tenant may send per day, whoever the recipients. */
  SMS_DAILY_LIMIT_PER_TENANT: z.coerce.number().int().min(0).default(200),
  /** SMS a tenant may send per day to one allowed prefix (a premium-rate pump hits one prefix). */
  SMS_DAILY_LIMIT_PER_PREFIX: z.coerce.number().int().min(0).default(100),
  /** SMS one user may be sent per day (codes included). */
  SMS_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(0).default(10),
  /** Codes one client IP may have texted per day in a tenant (the route also has its own throttle). */
  SMS_DAILY_LIMIT_PER_IP: z.coerce.number().int().min(0).default(20),
  /** A tenant's SMS spend cap per UTC month, in minor units of one currency; 0 is no cap. Sending stops at the cap; 80 % is logged as an error and shown by `sms_budget_used_ratio`. */
  SMS_MONTHLY_BUDGET_MINOR: z.coerce.number().int().min(0).default(0),
  /** The price of one SMS segment per prefix, minor units: `+1=79,+44=120`. */
  SMS_PRICES: list().transform((entries, ctx) => {
    const prices: Record<string, number> = {};
    for (const entry of entries) {
      const [prefix, price] = entry.split('=').map((part) => part.trim());
      if (
        !prefix ||
        !/^\+[1-9]\d{0,5}$/.test(prefix) ||
        !/^\d+$/.test(price ?? '')
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `"${entry}" is not <+prefix>=<minor units>`,
        });
        return z.NEVER;
      }
      prices[prefix] = Number(price);
    }
    return prices;
  }),
  /** The price of one SMS segment to a prefix SMS_PRICES does not list. */
  SMS_PRICE_DEFAULT_MINOR: z.coerce.number().int().min(0).default(0),
  /** The longest SMS text, in characters; a longer one is cut. */
  SMS_MAX_LENGTH: z.coerce.number().int().min(1).max(1600).default(320),
  /** The longest push payload, in bytes (web push allows about 4 KB); a longer body is cut. */
  PUSH_MAX_PAYLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(256)
    .max(4096)
    .default(3500),
  /** A person's devices that have not been seen for this many days are removed every night. */
  DEVICES_RETENTION_DAYS: z.coerce.number().int().min(1).default(270),

  // Email deliverability (platform/deliverability, docs/deliverability.md).
  /**
   * The SNS topics whose notifications `POST /webhooks/mail/ses` accepts
   * (comma-separated ARNs): the ones SES publishes bounces and complaints
   * to. Empty: every notification is refused (403), so the route is inert
   * until the topic is configured.
   */
  SES_SNS_TOPIC_ARNS: list(),
  /**
   * Postmark's webhooks (`POST /webhooks/mail/postmark`): the shared secret,
   * sent as the Basic Auth password of the webhook URL or in the
   * `X-Postmark-Webhook-Secret` header (Postmark does not sign). Unset: refused (403).
   */
  POSTMARK_WEBHOOK_SECRET: secret(optional()),
  /**
   * Resend's signed webhooks (`POST /webhooks/mail/resend`): the endpoint's
   * signing secret (`whsec_…`, shown in Resend's Webhooks page), verified the
   * Svix way. Unset: refused (403).
   */
  RESEND_WEBHOOK_SECRET: secret(optional()),
  /**
   * SendGrid's signed Event Webhook (`POST /webhooks/mail/sendgrid`): the
   * verification key the console shows (base64 SPKI). Public, not a secret.
   * Unset: refused (403).
   */
  SENDGRID_WEBHOOK_PUBLIC_KEY: optional(),
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

  /** Users' pictures (PUT /v1/account/avatar): the largest, in MB. */
  AVATAR_MAX_MB: z.coerce.number().int().min(1).max(50).default(2),

  /**
   * Malware scanning of uploads (platform/attachments, docs/attachments.md).
   * `off` (default): files are served as soon as they are stored. `clamav`:
   * a queue job streams each upload to clamd (CLAMAV_HOST); it is `pending`
   * (not downloadable) until clean, and an infected one is deleted.
   * `memory`: tests (flags the EICAR test string).
   */
  MALWARE_SCANNER: choice(['off', 'clamav', 'memory'], 'off'),
  /** clamd's host (`clamav` in Compose); required with MALWARE_SCANNER=clamav. */
  CLAMAV_HOST: optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /** One scan's limit, in milliseconds (connect, stream and answer); a scan that takes longer is tried again. */
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Tries per scan, the first included (exponential backoff from 5 s), before the attachment stays pending for the retry job (every 5 minutes) to queue again. */
  MALWARE_SCAN_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  /**
   * Image attachments (platform/images, docs/attachments.md, "Image
   * renditions"): a queue job makes a thumbnail and a preview of each
   * uploaded JPEG, PNG, WebP or GIF, after the malware scan found it clean,
   * and removes the metadata (EXIF, GPS…) of the original. `off`: images
   * are stored as uploaded, with no renditions.
   */
  IMAGE_PROCESSING: flag('on'),
  /**
   * Pixels of one frame (width × height) an image may have to be processed;
   * more is refused from its header, before a pixel is decoded (a decompression
   * bomb: 50 KB of PNG can claim gigapixels). The image stays as uploaded.
   * Memory is about 4 bytes per pixel while one image is converted: raise it
   * with WORKER_MEMORY.
   */
  IMAGE_MAX_PIXELS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(268_402_689)
    .default(50_000_000),
  /** One conversion's limit, in milliseconds; an image that takes longer stays as uploaded. */
  IMAGE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  /**
   * `on`: an original that carries metadata (EXIF, GPS, XMP, IPTC) is
   * replaced by a copy without it (re-encoded: JPEG and WebP at quality 90,
   * upright). `off`: originals stay byte for byte as uploaded; only the
   * renditions are stripped.
   */
  IMAGE_STRIP_ORIGINALS: flag('on'),

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

  /**
   * The AI helper (platform/ai): an Anthropic API key. Unset: the helper is
   * off and asking for it answers 503 `ai_unavailable`; nothing is sent
   * anywhere. A tenant also opts in (the `ai.enabled` setting).
   */
  ANTHROPIC_API_KEY: secret(optional()),
  /** Another Anthropic-compatible endpoint (a gateway, a test stand-in). Unset: Anthropic's. */
  AI_BASE_URL: baseUrl(),
  /** The model for normal tasks (pinned: the id is stored on every run and in cache keys). */
  AI_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  /** The model for cheap, simple tasks. */
  AI_MODEL_CHEAP: z.string().min(1).default('claude-haiku-5-5'),
  /** One call's limit in milliseconds (the queue's lock outlasts it: at most 120 000). */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(60_000),
  /** The most tokens one answer may have. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(1024),
  /** Tries per run, the first included (exponential backoff from 2 s), before it fails. */
  AI_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** Tokens (in and out) one tenant may use per UTC day; 0 is no cap. Cached answers cost none. */
  AI_TENANT_DAILY_TOKENS: z.coerce.number().int().min(0).default(500_000),
  /** How long an answer to the same prompt (same tenant, model and prompt version) is reused; 0 is never. */
  AI_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),

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
