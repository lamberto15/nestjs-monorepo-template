// What `pnpm setup` writes, from the answers: the questions (in the order they
// are asked), the env variables each answer sets, the secrets to generate,
// the masked diff and the warnings. Pure (no I/O, no prompts); the secrets'
// randomness is injected. tools/setup/setup.mjs asks and writes.
//
// A question is asked only when the target's template names its variables
// (active or as a commented example), so the wizard never invents a variable;
// setup.test.mjs checks the templates still name every one it can write.
import { randomBytes } from 'node:crypto';
import { generateVapidKeys } from './vapid.mjs';

/** The host of a URL, or '' when it isn't one. */
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Something@something.something. The domain is read up to its first dot
// after its first character, so no two quantifiers can share a character:
// linear time (SonarCloud S8786; `[^\s@]+\.[^\s@]+` backtracked over every dot).
const EMAIL = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/;
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/** An address no mail can reach (the template's, or a reserved domain). */
const PLACEHOLDER_EMAIL =
  /@(example\.(com|net|org)|[^@]*\.(invalid|test|localhost))$/i;

const email = (v) => (EMAIL.test(v) ? null : 'an email address');
const hostname = (v) => (HOSTNAME.test(v) ? null : 'a host name, no scheme');
const httpUrl = (v) =>
  /^https?:\/\/[^\s/]+/.test(v) ? null : 'an http(s) URL';
/** Empty, or an http(s) URL (the variable is off when empty). */
const optionalUrl = (v) => (v === '' ? null : httpUrl(v));
/** The VAPID contact: `mailto:` an address, or an https URL. */
const vapidSubject = (v) =>
  (v.startsWith('mailto:') && EMAIL.test(v.slice('mailto:'.length))) ||
  /^https:\/\/[^\s/]+/.test(v)
    ? null
    : 'mailto:ops@example.com or an https URL';
/** Twilio's sender: a number in E.164 or a Messaging Service SID (MG...). */
const twilioFrom = (v) =>
  /^(\+[1-9]\d{6,14}|MG[0-9a-zA-Z]{32})$/.test(v)
    ? null
    : 'a number like +15551234567, or a Messaging Service SID (MG...)';
/** Country calling-code prefixes, comma-separated (+1,+44); empty: none. */
const callingPrefixes = (v) =>
  v === '' || v.split(',').every((p) => /^\+[1-9]\d{0,5}$/.test(p.trim()))
    ? null
    : 'prefixes like +1,+44';

/** PUSH_PROVIDER's list, without `off`. */
const providersOf = (value) =>
  (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && name !== 'off');

/** Mail transports, with the template variables each needs besides MAIL_TRANSPORT. */
const MAIL_TRANSPORTS = {
  log: [],
  smtp: ['SMTP_URL'],
  resend: ['MAIL_API_KEY'],
  postmark: ['MAIL_API_KEY'],
  sendgrid: ['MAIL_API_KEY'],
  ses: [],
};

/** Providers of social sign-in: the id and client-secret variables of each (iam.env.ts). */
const SOCIAL = {
  google: { id: 'GOOGLE_CLIENT_ID', sec: 'GOOGLE_CLIENT_SECRET' },
  microsoft: {
    id: 'MICROSOFT_CLIENT_ID',
    sec: 'MICROSOFT_CLIENT_SECRET',
    tenant: 'MICROSOFT_TENANT_ID',
  },
  github: { id: 'GITHUB_CLIENT_ID', sec: 'GITHUB_CLIENT_SECRET' },
};

const flag = (on) => (on ? 'on' : 'off');
const onOff = (value) => value === 'on';
/** An env value as a boolean answer (the variable missing: no answer). */
const isOn = (value) => (value ? onOff(value) : undefined);
const isSet = (value) => (value === undefined ? undefined : value !== '');

/** Uses S3 or SES, which take the AWS_* keys. */
const usesAws = (a) => a.storage === 's3' || a.mail === 'ses';

/**
 * The existing file keeps the credential in a file (`<key>_FILE`, Docker or
 * Swarm secrets): the variable is not made or written here, since the app
 * refuses to start with both set. For a secret question, applies() is where
 * this is decided.
 */
const keptInFile = (key, ctx) => Boolean(ctx.existing?.get(`${key}_FILE`));

/**
 * The questions. Each has:
 *   id, label, type ('choice' | 'bool' | 'text'), choices (a list, or a
 *   function of the context, to filter by the template);
 *   keys     the template variables it needs (missing: not asked);
 *   target   'production' when it is only asked there;
 *   when     (answers, ctx) => asked at all;
 *   fresh    (ctx, answers) => the default of a first run;
 *   read     (env, answers) => the answer an existing file implies;
 *   write    (value, answers, ctx) => { KEY: value | null } to set (null: empty);
 *   required an empty answer is an error (--yes names the flag);
 *   validate (value) => null, or what the answer must be;
 *   secret   a credential: never shown, kept by default on a re-run; not
 *            asked (and its variable not written) when the existing file keeps
 *            it in `<NAME>_FILE`, whichever variable `write` sets (applies());
 *   hint     said before the question.
 * The context: { target, tpl (the template's values), keys (the names it
 * has), current (the file's values now), existing (a Map, or null),
 * hasNotes }.
 */
export const QUESTIONS = [
  {
    id: 'tenancy',
    label: 'One organization or many?',
    hint: 'single: one organization (one customer); multi: operators make more. Chosen once (docs/tenancy.md).',
    type: 'choice',
    choices: ['multi', 'single'],
    keys: ['TENANCY'],
    fresh: () => 'multi',
    read: (env) => env.TENANCY,
    write: (v) => ({ TENANCY: v }),
  },
  {
    id: 'adminEmail',
    label: 'First administrator email',
    type: 'text',
    keys: ['ADMIN_EMAIL'],
    target: 'production',
    fresh: () => 'admin@example.com',
    read: (env) => env.ADMIN_EMAIL,
    validate: email,
    write: (v) => ({ ADMIN_EMAIL: v }),
  },
  {
    id: 'tenantName',
    label: 'Organization (tenant) name',
    type: 'text',
    keys: ['ADMIN_TENANT_NAME'],
    target: 'production',
    fresh: () => 'Default',
    read: (env) => env.ADMIN_TENANT_NAME,
    write: (v) => ({ ADMIN_TENANT_NAME: v }),
  },
  {
    id: 'appDomain',
    label: "API host name (Caddy's HTTPS), e.g. api.example.com",
    type: 'text',
    keys: ['APP_DOMAIN'],
    target: 'production',
    read: (env) => (env.APP_DOMAIN === 'api.example.com' ? '' : env.APP_DOMAIN),
    required: true,
    validate: hostname,
    write: (v) => ({ APP_DOMAIN: v }),
  },
  {
    id: 'acmeEmail',
    label: "Email for Let's Encrypt (ACME)",
    type: 'text',
    keys: ['ACME_EMAIL'],
    target: 'production',
    read: (env) => env.ACME_EMAIL,
    required: true,
    validate: email,
    write: (v) => ({ ACME_EMAIL: v }),
  },
  {
    id: 'cloudflareApiToken',
    label: 'Cloudflare API token (Zone.DNS edit on the domain)',
    type: 'text',
    secret: true,
    keys: ['CLOUDFLARE_API_TOKEN'],
    target: 'production',
    read: (env) => env.CLOUDFLARE_API_TOKEN,
    required: true,
    write: (v) => ({ CLOUDFLARE_API_TOKEN: v }),
  },
  {
    id: 'webUrl',
    label: 'Web app URL (links in emails; empty: none yet)',
    type: 'text',
    keys: ['WEB_URL'],
    target: 'production',
    fresh: () => '',
    read: (env) => env.WEB_URL,
    validate: (v) => (v === '' ? null : httpUrl(v)),
    write: (v) => ({ WEB_URL: v || null }),
  },
  {
    id: 'corsOrigins',
    label: 'Web origins allowed by CORS (comma-separated)',
    type: 'text',
    keys: ['CORS_ORIGINS'],
    target: 'production',
    fresh: (ctx, a) => (a.webUrl ? new URL(a.webUrl).origin : ''),
    read: (env) => env.CORS_ORIGINS,
    write: (v) => ({ CORS_ORIGINS: v || null }),
  },
  {
    id: 'signUp',
    label: 'Let anyone sign up themselves?',
    type: 'bool',
    keys: ['AUTH_SIGN_UP'],
    fresh: () => false,
    read: (env) => isOn(env.AUTH_SIGN_UP),
    write: (v) => ({ AUTH_SIGN_UP: flag(v) }),
  },
  {
    id: 'signUpRoles',
    label:
      'Roles a sign-up gets (seed role keys, comma-separated; never administrator)',
    type: 'text',
    keys: ['SIGN_UP_ROLES'],
    when: (a) => a.tenancy === 'single' && a.signUp,
    fresh: () => '',
    read: (env) => env.SIGN_UP_ROLES,
    write: (v) => ({ SIGN_UP_ROLES: v || null }),
  },
  {
    id: 'tenantSignUp',
    label: 'Does a sign-up make its own tenant (and administer it)?',
    type: 'bool',
    keys: ['TENANT_SIGN_UP'],
    when: (a) => a.tenancy === 'multi' && a.signUp,
    fresh: () => false,
    read: (env) => isOn(env.TENANT_SIGN_UP),
    write: (v) => ({ TENANT_SIGN_UP: flag(v) }),
  },
  {
    id: 'mail',
    label: 'Mail transport',
    type: 'choice',
    choices: (ctx) =>
      Object.keys(MAIL_TRANSPORTS).filter((name) =>
        MAIL_TRANSPORTS[name].every((key) => ctx.keys.has(key)),
      ),
    keys: ['MAIL_TRANSPORT'],
    // Development's template points mail at Floci's SES (and on to Mailpit).
    fresh: (ctx) => (ctx.target === 'development' ? 'ses' : 'log'),
    read: (env) => env.MAIL_TRANSPORT,
    write: (v) => ({ MAIL_TRANSPORT: v }),
  },
  {
    id: 'mailFrom',
    label: 'Mail sender (From address)',
    type: 'text',
    keys: ['MAIL_FROM'],
    when: (a) => a.mail !== 'log',
    fresh: (ctx) =>
      ctx.target === 'development' ? ctx.tpl.get('MAIL_FROM') : undefined,
    read: (env) => env.MAIL_FROM,
    required: true,
    write: (v) => ({ MAIL_FROM: v }),
  },
  {
    id: 'smtpUrl',
    label: 'SMTP URL (with the account and its credential, percent-encoded)',
    type: 'text',
    secret: true,
    keys: ['SMTP_URL'],
    when: (a) => a.mail === 'smtp',
    fresh: (ctx) =>
      ctx.target === 'development' ? 'smtp://127.0.0.1:1025' : undefined,
    read: (env) => env.SMTP_URL,
    required: true,
    write: (v) => ({ SMTP_URL: v }),
  },
  {
    id: 'mailApiKey',
    label: 'Mail provider API key',
    type: 'text',
    secret: true,
    keys: ['MAIL_API_KEY'],
    when: (a) => ['resend', 'postmark', 'sendgrid'].includes(a.mail),
    read: (env) => env.MAIL_API_KEY,
    required: true,
    write: (v) => ({ MAIL_API_KEY: v }),
  },
  {
    id: 'storage',
    label: 'File storage',
    type: 'choice',
    choices: ['local', 's3'],
    keys: ['STORAGE_DRIVER'],
    // Development's template uses Floci's S3.
    fresh: (ctx) => (ctx.target === 'development' ? 's3' : 'local'),
    read: (env) => env.STORAGE_DRIVER,
    write: (v) => ({ STORAGE_DRIVER: v }),
  },
  {
    id: 's3Bucket',
    label: 'S3 bucket',
    type: 'text',
    keys: ['S3_BUCKET'],
    target: 'production',
    when: (a) => a.storage === 's3',
    read: (env) => env.S3_BUCKET,
    required: true,
    write: (v) => ({ S3_BUCKET: v }),
  },
  {
    id: 's3Endpoint',
    label:
      'S3 endpoint (empty for AWS; R2: https://<account id>.r2.cloudflarestorage.com)',
    type: 'text',
    keys: ['S3_ENDPOINT'],
    target: 'production',
    when: (a) => a.storage === 's3',
    fresh: () => '',
    read: (env) => env.S3_ENDPOINT,
    validate: (v) => (v === '' ? null : httpUrl(v)),
    write: (v) => ({ S3_ENDPOINT: v || null }),
  },
  {
    id: 'awsRegion',
    label: 'AWS region (R2: auto)',
    type: 'text',
    keys: ['AWS_REGION'],
    target: 'production',
    when: usesAws,
    fresh: () => 'us-east-1',
    read: (env) => env.AWS_REGION,
    write: (v) => ({ AWS_REGION: v }),
  },
  {
    id: 'awsAccessKeyId',
    label: 'AWS access key id (empty: the host IAM role)',
    type: 'text',
    keys: ['AWS_ACCESS_KEY_ID'],
    target: 'production',
    when: usesAws,
    fresh: () => '',
    read: (env) => env.AWS_ACCESS_KEY_ID,
    write: (v) => ({ AWS_ACCESS_KEY_ID: v || null }),
  },
  {
    id: 'awsSecretAccessKey',
    label: 'AWS secret access key (empty: the host IAM role)',
    type: 'text',
    secret: true,
    keys: ['AWS_SECRET_ACCESS_KEY'],
    target: 'production',
    when: usesAws,
    fresh: () => '',
    read: (env) => env.AWS_SECRET_ACCESS_KEY,
    write: (v) => ({ AWS_SECRET_ACCESS_KEY: v || null }),
  },
  {
    id: 'captcha',
    label: 'Bot protection on sign-in and sign-up',
    hint: 'turnstile: Cloudflare Turnstile on sign-in, sign-up and password requests (docs/auth.md).',
    type: 'choice',
    choices: ['none', 'turnstile'],
    keys: ['CAPTCHA_MODE', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
    fresh: () => 'none',
    read: (env) =>
      env.CAPTCHA_MODE === undefined || env.CAPTCHA_MODE === ''
        ? undefined
        : env.CAPTCHA_MODE === 'off'
          ? 'none'
          : 'turnstile',
    write: (v, a, ctx) => {
      const mode = ctx.current.get('CAPTCHA_MODE');
      const on = mode && mode !== 'off';
      // None writes nothing unless it switches an existing mode off.
      if (v === 'none') return on ? { CAPTCHA_MODE: 'off' } : {};
      return { CAPTCHA_MODE: on ? mode : 'always' };
    },
  },
  {
    id: 'turnstileSiteKey',
    label: 'Turnstile site key (public)',
    type: 'text',
    keys: ['TURNSTILE_SITE_KEY'],
    when: (a) => a.captcha === 'turnstile',
    read: (env) => env.TURNSTILE_SITE_KEY,
    required: true,
    write: (v) => ({ TURNSTILE_SITE_KEY: v }),
  },
  {
    id: 'turnstileSecretKey',
    label: 'Turnstile secret key',
    type: 'text',
    secret: true,
    keys: ['TURNSTILE_SECRET_KEY'],
    when: (a) => a.captcha === 'turnstile',
    read: (env) => env.TURNSTILE_SECRET_KEY,
    required: true,
    write: (v) => ({ TURNSTILE_SECRET_KEY: v }),
  },
  {
    id: 'passkeys',
    label: 'Passkeys (WebAuthn sign-in)?',
    type: 'bool',
    keys: ['PASSKEYS'],
    fresh: () => true,
    read: (env) => isOn(env.PASSKEYS),
    write: (v) => ({ PASSKEYS: flag(v) }),
  },
  {
    id: 'passkeyRpId',
    label:
      'Passkey relying party id (a domain; empty: the web app host, else the API host)',
    hint: 'WARNING: every passkey is bound to this id; it can never change once users register passkeys.',
    type: 'text',
    keys: ['PASSKEY_RP_ID'],
    when: (a) => a.passkeys,
    fresh: (ctx, a) => hostOf(a.webUrl ?? ''),
    read: (env) => env.PASSKEY_RP_ID,
    validate: (v) => (v === '' ? null : hostname(v)),
    write: (v) => ({ PASSKEY_RP_ID: v || null }),
  },
  {
    id: 'social',
    label: 'Social sign-in',
    type: 'choice',
    choices: (ctx) => [
      'none',
      ...Object.keys(SOCIAL).filter((name) => providerInTemplate(name, ctx)),
    ],
    keys: [],
    // Nothing to choose when the template names no provider.
    available: socialAvailable,
    fresh: () => 'none',
    read: (env) =>
      Object.keys(SOCIAL).find((name) => env[SOCIAL[name].id]) ?? 'none',
    write: (v) => {
      if (v !== 'none') return {};
      // None empties every provider: the one way a re-run switches it off.
      const out = {};
      for (const p of Object.values(SOCIAL)) {
        out[p.id] = null;
        out[p.sec] = null;
      }
      return out;
    },
  },
  {
    id: 'socialClientId',
    label: 'Client id of the provider',
    type: 'text',
    keys: [],
    available: socialAvailable,
    when: (a) => !!a.social && a.social !== 'none',
    read: (env, a) => env[SOCIAL[a.social]?.id],
    required: true,
    write: (v, a) => ({ [SOCIAL[a.social].id]: v }),
  },
  {
    id: 'socialClientSecret',
    label: 'Client secret of the provider',
    type: 'text',
    secret: true,
    keys: [],
    available: socialAvailable,
    when: (a) => !!a.social && a.social !== 'none',
    read: (env, a) => env[SOCIAL[a.social]?.sec],
    required: true,
    write: (v, a) => ({ [SOCIAL[a.social].sec]: v }),
  },
  {
    id: 'microsoftTenantId',
    label: 'Microsoft Entra tenant id (a GUID)',
    type: 'text',
    keys: [],
    available: socialAvailable,
    when: (a) => a.social === 'microsoft',
    read: (env) => env.MICROSOFT_TENANT_ID,
    required: true,
    write: (v) => ({ MICROSOFT_TENANT_ID: v }),
  },
  {
    id: 'authMfa',
    label: 'Let users set up two-factor sign-in (TOTP, recovery codes)?',
    type: 'bool',
    keys: ['AUTH_MFA'],
    fresh: () => true,
    read: (env) => isOn(env.AUTH_MFA),
    write: (v) => ({ AUTH_MFA: flag(v) }),
  },
  {
    id: 'apiClients',
    label: 'API clients and their keys (sk_...)?',
    hint: 'Off: their routes answer 404 and keys stop working (docs/auth.md).',
    type: 'bool',
    keys: ['API_CLIENTS'],
    fresh: () => true,
    read: (env) => isOn(env.API_CLIENTS),
    write: (v) => ({ API_CLIENTS: flag(v) }),
  },
  {
    id: 'impersonation',
    label: 'Support impersonation (an administrator acts as a user)?',
    hint: 'WARNING: a privileged support tool; an administrator can act as any user (audited). Leave off unless support needs it.',
    type: 'bool',
    keys: ['IMPERSONATION'],
    // The template's value is the default (development's turns it on to try it).
    fresh: (ctx) => ctx.tpl?.get('IMPERSONATION') === 'on',
    read: (env) => isOn(env.IMPERSONATION),
    write: (v) => ({ IMPERSONATION: flag(v) }),
  },
  {
    id: 'exchangeRates',
    label: "Fetch the ECB's exchange rates every working day?",
    type: 'bool',
    keys: ['EXCHANGE_RATES_FETCH'],
    fresh: () => false,
    read: (env) => isOn(env.EXCHANGE_RATES_FETCH),
    write: (v) => ({ EXCHANGE_RATES_FETCH: flag(v) }),
  },
  {
    id: 'documents',
    label: 'PDF documents (Gotenberg)?',
    type: 'bool',
    keys: ['GOTENBERG_URL'],
    // Development's services run Gotenberg, and its template sets the URL.
    fresh: (ctx) => ctx.target === 'development',
    read: (env) => isSet(env.GOTENBERG_URL),
    write: (v, a, ctx) => ({
      GOTENBERG_URL: v
        ? ctx.current.get('GOTENBERG_URL') ||
          (ctx.target === 'development'
            ? 'http://127.0.0.1:3100'
            : 'http://gotenberg:3000')
        : null,
    }),
  },
  {
    id: 'metrics',
    label: 'Prometheus metrics at /metrics (a token is generated)?',
    type: 'bool',
    keys: ['METRICS_TOKEN'],
    fresh: () => false,
    read: (env) => isSet(env.METRICS_TOKEN),
    // On: the token is a generated secret (SECRETS). Off: empty.
    write: (v) => (v ? {} : { METRICS_TOKEN: null }),
  },
  {
    id: 'observe',
    label: 'NestJS Observe (traces, metrics, errors)?',
    hint: "Keys from the application's project, API keys page. Off empties both.",
    type: 'bool',
    keys: ['OBSERVE_APP_KEY', 'OBSERVE_APP_SECRET'],
    target: 'production',
    fresh: () => false,
    read: (env) => isSet(env.OBSERVE_APP_KEY),
    write: (v) =>
      v ? {} : { OBSERVE_APP_KEY: null, OBSERVE_APP_SECRET: null },
  },
  {
    id: 'observeAppKey',
    label: 'Observe application key',
    type: 'text',
    keys: ['OBSERVE_APP_KEY'],
    target: 'production',
    when: (a) => a.observe,
    read: (env) => env.OBSERVE_APP_KEY,
    required: true,
    write: (v) => ({ OBSERVE_APP_KEY: v }),
  },
  {
    id: 'observeAppSecret',
    label: 'Observe application secret',
    type: 'text',
    secret: true,
    keys: ['OBSERVE_APP_SECRET'],
    target: 'production',
    when: (a) => a.observe,
    read: (env) => env.OBSERVE_APP_SECRET,
    required: true,
    write: (v) => ({ OBSERVE_APP_SECRET: v }),
  },
  {
    id: 'otelEndpoint',
    label: 'OpenTelemetry collector URL (OTLP/HTTP; empty: off)',
    type: 'text',
    keys: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
    target: 'production',
    fresh: () => '',
    read: (env) => env.OTEL_EXPORTER_OTLP_ENDPOINT,
    validate: optionalUrl,
    write: (v) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: v || null }),
  },
  {
    id: 'otelHeaders',
    label:
      "The collector's credential header (x-honeycomb-team=KEY; empty: none)",
    type: 'text',
    secret: true,
    keys: ['OTEL_EXPORTER_OTLP_HEADERS'],
    target: 'production',
    when: (a) => !!a.otelEndpoint,
    fresh: () => '',
    read: (env) => env.OTEL_EXPORTER_OTLP_HEADERS,
    write: (v) => ({ OTEL_EXPORTER_OTLP_HEADERS: v || null }),
  },
  {
    id: 'sentryDsn',
    label: 'Sentry DSN (error tracking; empty: off)',
    type: 'text',
    secret: true,
    keys: ['SENTRY_DSN'],
    target: 'production',
    fresh: () => '',
    read: (env) => env.SENTRY_DSN,
    validate: optionalUrl,
    write: (v) => ({ SENTRY_DSN: v || null }),
  },
  {
    id: 'anthropicApiKey',
    label: 'Anthropic API key for the AI helper (empty: off; docs/ai.md)',
    type: 'text',
    secret: true,
    keys: ['ANTHROPIC_API_KEY'],
    target: 'production',
    fresh: () => '',
    read: (env) => env.ANTHROPIC_API_KEY,
    write: (v) => ({ ANTHROPIC_API_KEY: v || null }),
  },
  {
    id: 'push',
    label: 'Web Push (browser notifications; the VAPID keys are generated)?',
    hint: 'Adds web-push to PUSH_PROVIDER; APNs and FCM are set in the file (docs/notifications.md, "Push and SMS").',
    type: 'bool',
    keys: [
      'PUSH_PROVIDER',
      'WEB_PUSH_VAPID_PUBLIC_KEY',
      'WEB_PUSH_VAPID_PRIVATE_KEY',
      'WEB_PUSH_SUBJECT',
    ],
    target: 'production',
    fresh: () => false,
    read: (env) =>
      env.PUSH_PROVIDER
        ? providersOf(env.PUSH_PROVIDER).includes('web-push')
        : undefined,
    // The list keeps the other providers (apns, fcm) it already names.
    write: (v, a, ctx) => {
      const others = providersOf(ctx.current.get('PUSH_PROVIDER')).filter(
        (name) => name !== 'web-push',
      );
      return {
        PUSH_PROVIDER:
          (v ? [...others, 'web-push'] : others).join(',') || 'off',
      };
    },
  },
  {
    id: 'webPushSubject',
    label: 'Web Push contact (mailto:ops@example.com, or an https URL)',
    type: 'text',
    keys: ['WEB_PUSH_SUBJECT'],
    target: 'production',
    when: (a) => a.push,
    // The administrator's address, unless it is the template's placeholder.
    fresh: (ctx, a) =>
      a.adminEmail && !PLACEHOLDER_EMAIL.test(a.adminEmail)
        ? `mailto:${a.adminEmail}`
        : undefined,
    read: (env) => env.WEB_PUSH_SUBJECT,
    required: true,
    validate: vapidSubject,
    write: (v) => ({ WEB_PUSH_SUBJECT: v }),
  },
  {
    id: 'sms',
    label: 'SMS through Twilio?',
    hint: 'Off: nothing leaves. Phone numbers are encrypted at rest (the keys are generated).',
    type: 'bool',
    keys: [
      'SMS_PROVIDER',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM',
    ],
    target: 'production',
    fresh: () => false,
    read: (env) =>
      env.SMS_PROVIDER ? env.SMS_PROVIDER === 'twilio' : undefined,
    // Off keeps the credentials (the provider is the switch); only twilio is switched off.
    write: (v, a, ctx) =>
      v
        ? { SMS_PROVIDER: 'twilio' }
        : ctx.current.get('SMS_PROVIDER') === 'twilio'
          ? { SMS_PROVIDER: 'off' }
          : {},
  },
  {
    id: 'twilioAccountSid',
    label: 'Twilio account SID',
    type: 'text',
    keys: ['TWILIO_ACCOUNT_SID'],
    target: 'production',
    when: (a) => a.sms,
    read: (env) => env.TWILIO_ACCOUNT_SID,
    required: true,
    write: (v) => ({ TWILIO_ACCOUNT_SID: v }),
  },
  {
    id: 'twilioAuthToken',
    label: 'Twilio auth token',
    type: 'text',
    secret: true,
    keys: ['TWILIO_AUTH_TOKEN'],
    target: 'production',
    when: (a) => a.sms,
    read: (env) => env.TWILIO_AUTH_TOKEN,
    required: true,
    write: (v) => ({ TWILIO_AUTH_TOKEN: v }),
  },
  {
    id: 'twilioFrom',
    label: 'Twilio sender (E.164 number, or a Messaging Service SID MG...)',
    type: 'text',
    keys: ['TWILIO_FROM'],
    target: 'production',
    when: (a) => a.sms,
    read: (env) => env.TWILIO_FROM,
    required: true,
    validate: twilioFrom,
    write: (v) => ({ TWILIO_FROM: v }),
  },
  {
    id: 'smsAllowedPrefixes',
    label: 'Country calling-code prefixes SMS may go to (+1,+44; empty: none)',
    hint: 'Toll-fraud guard: with none listed, no SMS is sent.',
    type: 'text',
    keys: ['SMS_ALLOWED_PREFIXES'],
    target: 'production',
    when: (a) => a.sms,
    fresh: () => '',
    read: (env) => env.SMS_ALLOWED_PREFIXES,
    validate: callingPrefixes,
    write: (v) => ({ SMS_ALLOWED_PREFIXES: v || null }),
  },
  {
    id: 'idempotency',
    label: 'Idempotency-Key on writes',
    hint: 'required: a write without the header is refused, so a retry never creates twice; optional: the header is honoured when sent.',
    type: 'choice',
    choices: ['required', 'optional'],
    keys: ['IDEMPOTENCY'],
    fresh: () => 'required',
    read: (env) => env.IDEMPOTENCY,
    write: (v) => ({ IDEMPOTENCY: v }),
  },
  ...[
    ['webhooks', 'WEBHOOKS', 'Outgoing webhooks (endpoints, deliveries)?'],
    ['reports', 'REPORTS', 'Scheduled reports?'],
    ['usage', 'USAGE', "API clients' usage metering and daily quotas?"],
    ['realtime', 'REALTIME', 'Realtime socket.io gateway (/realtime)?'],
  ].map(([id, key, label], index) => ({
    id,
    label,
    // Said once, before the group: off leaves a module's routes, workers and jobs out.
    hint:
      index === 0
        ? 'Optional platform services (docs/configuration.md, "Deployment switches"): off leaves a module\'s routes, workers and jobs out.'
        : undefined,
    type: 'bool',
    keys: [key],
    fresh: () => true,
    read: (env) => isOn(env[key]),
    // Development's template has these only as commented examples: on (the
    // default) leaves them alone, off writes the line.
    write: (v, a, ctx) =>
      v && !ctx.current.has(key) ? {} : { [key]: flag(v) },
  })),
  {
    id: 'removeNotes',
    label: 'Remove the example feature (notes)?',
    hint: 'It is the model to copy; a new project usually deletes it (pnpm feature:remove notes).',
    type: 'bool',
    keys: [],
    when: (a, ctx) => ctx.hasNotes,
    fresh: (ctx) => ctx.target === 'production',
    write: () => ({}),
  },
];

/** Whether the template names any social provider. */
function socialAvailable(ctx) {
  return Object.keys(SOCIAL).some((name) => providerInTemplate(name, ctx));
}

/** Whether the template names every variable of a social provider. */
function providerInTemplate(name, ctx) {
  return Object.values(SOCIAL[name]).every((key) => ctx.keys.has(key));
}

/**
 * A secret question whose variable the existing file keeps in `<NAME>_FILE`.
 * The variable is the one the question writes (a social provider's depends on
 * the answers), so no question names it a second time.
 */
function secretKept(q, answers, ctx) {
  if (!q.secret || !ctx.existing) return false;
  return Object.keys(q.write('', answers, ctx)).some((key) =>
    keptInFile(key, ctx),
  );
}

/** Whether the question is asked, given the answers so far. */
export function applies(q, answers, ctx) {
  if (q.target && q.target !== ctx.target) return false;
  if (!q.keys.every((key) => ctx.keys.has(key))) return false;
  if (q.available && !q.available(ctx)) return false;
  if (q.when && !q.when(answers, ctx)) return false;
  // Not asked, so not required and not written: a value made here would be a
  // second source next to the file.
  return !secretKept(q, answers, ctx);
}

/** The accepted values of a choice question. */
export function choicesOf(q, ctx) {
  return typeof q.choices === 'function' ? q.choices(ctx) : q.choices;
}

/**
 * The default of a question: what the existing file implies, else the fresh
 * default (undefined: no default, an answer is needed).
 */
export function defaultFor(q, answers, ctx) {
  if (ctx.existing && q.read) {
    const found = q.read(Object.fromEntries(ctx.existing), answers);
    if (found !== undefined && found !== '') return found;
  }
  return q.fresh?.(ctx, answers);
}

// The secrets: generated as env.example says (passwords are hex, keys and
// signing secrets base64), unless the existing file has them.
const hex24 = { kind: 'hex', bytes: 24 };
const base64x32 = { kind: 'base64', bytes: 32 };
export const SECRETS = [
  { key: 'POSTGRES_PASSWORD', ...hex24, database: true },
  { key: 'POSTGRES_APP_PASSWORD', ...hex24, database: true },
  { key: 'POSTGRES_MAINTENANCE_PASSWORD', ...hex24, database: true },
  { key: 'POSTGRES_MONITOR_PASSWORD', ...hex24, database: true },
  { key: 'POSTGRES_REPORTING_PASSWORD', ...hex24, database: true },
  { key: 'REDIS_PASSWORD', ...hex24, database: true },
  { key: 'METRICS_TOKEN', ...hex24, when: (a) => a.metrics === true },
  // Keys: comma-separated, newest first, so a rotation puts the new one in front.
  { key: 'IDEMPOTENCY_KEYS', ...base64x32, list: true },
  { key: 'WEBHOOKS_ENCRYPTION_KEYS', ...base64x32, list: true },
  { key: 'MFA_ENCRYPTION_KEYS', ...base64x32, list: true },
  { key: 'STORAGE_SIGNING_KEYS', ...base64x32, list: true },
  { key: 'CURSOR_KEYS', ...base64x32, list: true },
  // Encrypted columns (docs/encryption.md): never created by the app itself.
  { key: 'DATA_ENCRYPTION_KEYS', ...base64x32, list: true },
  { key: 'BLIND_INDEX_KEYS', ...base64x32, list: true },
  { key: 'JWT_SECRET', ...base64x32 },
  {
    key: 'EXAMPLE_SENDER_WEBHOOK_SECRET',
    ...base64x32,
    prefix: 'whsec_',
    when: (a) => a.removeNotes !== true,
  },
  // Only for a first file: the account exists after the first start.
  { key: 'ADMIN_PASSWORD', kind: 'base64', bytes: 18, first: true },
];

/** Web Push's key pair (the public one goes to browsers, the private signs). */
const VAPID_KEYS = ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY'];

/**
 * Every variable the wizard can write for the context's template, probing
 * the answers that reach each question (for the guard test).
 */
export function writableKeys(ctx) {
  const keys = new Set();
  const probes = [
    {
      tenancy: 'single',
      signUp: true,
      mail: 'smtp',
      storage: 's3',
      captcha: 'turnstile',
      passkeys: true,
      social: 'microsoft',
      documents: true,
      metrics: true,
      observe: true,
      otelEndpoint: 'https://otel.example.com',
      push: true,
      sms: true,
    },
    { mail: 'resend', social: 'google', captcha: 'none' },
    { social: 'github' },
    { social: 'none' },
  ];
  for (const answers of probes) {
    for (const q of QUESTIONS) {
      if (!applies(q, answers, ctx)) continue;
      // A bool is probed both ways: some answers write nothing (on, by default).
      for (const probe of q.type === 'bool' ? ['x', false] : ['x']) {
        for (const key of Object.keys(q.write(probe, answers, ctx))) {
          keys.add(key);
        }
      }
    }
  }
  for (const secret of SECRETS) {
    if (ctx.keys.has(secret.key)) keys.add(secret.key);
  }
  for (const key of VAPID_KEYS) {
    if (ctx.keys.has(key)) keys.add(key);
  }
  return keys;
}

const SENSITIVE =
  /(SECRET|PASSWORD|TOKEN|_KEYS?$|SMTP_URL|DATABASE_\w*URL|ACCESS_KEY|API_KEY|OTLP_HEADERS|SENTRY_DSN)/;

/** `value` for display: a secret's is hidden. */
export function mask(key, value) {
  if (value === null || value === undefined || value === '') return '';
  return SENSITIVE.test(key) ? '********' : value;
}

/** A new secret of the kind `secret` describes. */
function generate(secret, random) {
  return `${secret.prefix ?? ''}${random(secret.bytes).toString(secret.kind)}`;
}

/**
 * The plan: { values (Map KEY -> string | null), generated (the secrets
 * made now), adminPassword (the generated one, else undefined), rotated,
 * warnings }. `answers` holds one entry per asked question. The secrets'
 * randomness is `random`, Web Push's key pair is `vapid()` ({ publicKey,
 * privateKey }, or null when the web-push package is not installed).
 */
export function buildPlan({
  answers,
  ctx,
  rotate = false,
  random = randomBytes,
  vapid = generateVapidKeys,
}) {
  const values = new Map();
  for (const q of QUESTIONS) {
    if (!applies(q, answers, ctx) || answers[q.id] === undefined) continue;
    // A required answer still missing (a dry run) is not written.
    if (q.required && answers[q.id] === '') continue;
    for (const [key, value] of Object.entries(
      q.write(answers[q.id], answers, ctx),
    )) {
      values.set(key, value);
    }
  }

  const generated = [];
  const rotated = [];
  let adminPassword;
  const existing = ctx.existing;
  for (const secret of SECRETS) {
    if (!ctx.keys.has(secret.key)) continue;
    if (secret.when && !secret.when(answers)) continue;
    if (secret.first) {
      // A first file only, never rotated: the account exists after a first start.
      if (existing) continue;
      adminPassword = generate(secret, random);
      values.set(secret.key, adminPassword);
      generated.push(secret.key);
      continue;
    }
    // Kept in a file (KEY_FILE): a value made here would be a second source,
    // and the services refuse to start with both.
    if (keptInFile(secret.key, ctx)) continue;
    const old = existing?.get(secret.key) ?? '';
    if (old && !rotate) continue;
    const made = generate(secret, random);
    if (old) {
      values.set(secret.key, secret.list ? `${made},${old}` : made);
      rotated.push(secret);
    } else {
      values.set(secret.key, made);
    }
    generated.push(secret.key);
  }

  const warnings = [];
  const was = (key) => existing?.get(key) ?? '';

  // Web Push's key pair: made once. Never rotated, not even by --rotate:
  // every browser subscription is bound to the public key, so a new pair
  // ends them all (empty both lines to start over).
  if (answers.push === true) {
    const [publicKey, privateKey] = VAPID_KEYS;
    const kept =
      keptInFile(privateKey, ctx) ||
      (Boolean(was(publicKey)) && Boolean(was(privateKey)));
    if (!kept) {
      const pair = vapid();
      if (pair) {
        values.set(publicKey, pair.publicKey);
        values.set(privateKey, pair.privateKey);
        generated.push(privateKey, publicKey);
      } else {
        warnings.push(
          `The web-push package is not installed here (run pnpm install), so the VAPID keys were not made: run \`npx web-push generate-vapid-keys\` and set ${publicKey} and ${privateKey}, or the API refuses to start with PUSH_PROVIDER=web-push.`,
        );
      }
    }
  }
  if (answers.sms === true && !answers.smsAllowedPrefixes) {
    warnings.push(
      'SMS_ALLOWED_PREFIXES is empty: no SMS is sent until it lists the country calling-code prefixes to serve (+1,+44).',
    );
  }
  const changes = (key) =>
    was(key) !== '' && values.has(key) && was(key) !== (values.get(key) ?? '');
  const adminEmail = values.get('ADMIN_EMAIL') ?? was('ADMIN_EMAIL');
  if (ctx.target === 'production' && PLACEHOLDER_EMAIL.test(adminEmail)) {
    warnings.push(
      `ADMIN_EMAIL is the placeholder ${adminEmail}: no mail can reach the only administrator. The first sign-in forces a real, verified address and a new password (ADMIN_ONBOARDING, docs/auth.md); set a real one now to skip the address step.`,
    );
  }
  if (changes('TENANCY')) {
    warnings.push(
      `TENANCY changes from ${was('TENANCY')} to ${values.get('TENANCY')}: the deployment shape is chosen once; read docs/tenancy.md before switching a database that has data.`,
    );
  }
  if (changes('PASSKEY_RP_ID')) {
    warnings.push(
      `PASSKEY_RP_ID changes from ${was('PASSKEY_RP_ID')} to ${values.get('PASSKEY_RP_ID') ?? '(empty)'}: every passkey registered so far stops working.`,
    );
  }
  if (rotated.some((s) => s.database)) {
    warnings.push(
      'Rotated database or Redis passwords: PostgreSQL and Redis keep the old ones in their volumes; change them there too (ALTER ROLE, redis CONFIG) or the stack stops connecting.',
    );
  }
  if (rotated.some((s) => !s.database && !s.list)) {
    warnings.push(
      'Rotated JWT_SECRET (or another single secret): sessions and tokens signed with the old one stop working.',
    );
  }
  return {
    values,
    generated,
    adminPassword,
    rotated: rotated.map((s) => s.key),
    warnings,
  };
}

/** The keys that differ between the file now and the plan: [{ key, from, to }] (unmasked). */
export function diffValues(current, values) {
  const changes = [];
  for (const [key, to] of values) {
    const from = current.get(key) ?? '';
    if (from !== (to ?? '')) changes.push({ key, from, to: to ?? '' });
  }
  return changes;
}
