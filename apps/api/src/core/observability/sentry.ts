import { secretValue } from '../config/secret-files.js';
import { type LogRedaction, logRedaction } from '../logging/redaction.js';

/**
 * Sentry error tracking (`@sentry/nestjs`): off until `SENTRY_DSN` is set.
 *
 * Nothing leaves the process unscrubbed: `scrub()` runs the app's
 * log-redaction registry (core/logging/redaction.ts) over every event,
 * breadcrumb and transaction, so the names and shapes masked in the logs are
 * masked in Sentry. Sentry collects no user, cookies, bodies or query strings (`dataCollection`). The registry is read when
 * an event is sent, not when Sentry starts, so the names `env.ts` and the
 * API keys declare at import time are all there.
 */

/** Looser limits than the dashboard's: an event has long stack traces and many tags. */
const EVENT_LIMITS = {
  maxString: 8_000,
  maxDepth: 12,
  maxItems: 200,
  maxNodes: 5_000,
};

/** A Sentry event, breadcrumb or transaction with the secrets masked. */
export const scrub = <T>(value: T, redaction: LogRedaction = logRedaction): T =>
  redaction.redactValue(value, EVENT_LIMITS) as T;

/** `SENTRY_TRACES_SAMPLE_RATE`: 0 to 1; unset, no performance tracing (errors only). */
export const tracesSampleRate = (env: NodeJS.ProcessEnv = process.env) => {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE);
  return env.SENTRY_TRACES_SAMPLE_RATE?.trim() && rate >= 0 && rate <= 1
    ? rate
    : undefined;
};

/**
 * The integrations of Sentry's defaults that are left out, and why.
 * - "Nest": it wraps every provider method and controller handler (as NestJS
 *   Observe's proxies did, issue #392), which hides
 *   @OnOneInstance()/@WithoutOverlapping() jobs from @nestjs/locks
 *   ("LocksModule doesn't know this instance"). Unexpected errors reach
 *   Sentry through ErrorTracker (error-tracker.ts) instead.
 * - "OnUnhandledRejection": it listens for `unhandledRejection`, and with a
 *   listener there Node no longer raises the rejection as an uncaught
 *   exception, its default, which ends the process (Compose restarts it): the
 *   integration's default mode only logs. Without it that default stays, the
 *   app crashes on a floating rejection with or without a DSN, and the
 *   "OnUncaughtException" integration reports the crash before the process
 *   exits.
 */
const LEFT_OUT = new Set(['Nest', 'OnUnhandledRejection']);

/** `integrations` for `Sentry.init()`: its defaults without those left out. */
export const sentryIntegrations = <Integration extends { name: string }>(
  defaults: Integration[],
) => defaults.filter((integration) => !LEFT_OUT.has(integration.name));

/** Starts Sentry when `SENTRY_DSN` is set. */
export async function startSentry(env: NodeJS.ProcessEnv = process.env) {
  // The DSN may be a secret in a file (SENTRY_DSN_FILE). This runs before the
  // environment is validated, which is what reads those, so it is read here
  // (a file that can't be read is for the validation to report).
  const { value: dsn } = secretValue(env, 'SENTRY_DSN');
  if (!dsn) {
    return false;
  }
  const Sentry = await import('@sentry/nestjs');
  Sentry.init({
    dsn,
    environment: env.APP_ENV || env.NODE_ENV,
    // Set by the image's GIT_SHA build argument; empty in a local build.
    release: env.GIT_SHA || undefined,
    serverName: env.SERVICE_NAME || undefined,
    // No personal data of its own: no user, cookies, request bodies or query
    // strings (what remains is scrubbed again in beforeSend).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    integrations: sentryIntegrations,
    tracesSampleRate: tracesSampleRate(env),
    beforeSend: (event) => scrub(event),
    beforeSendSpan: (span) => scrub(span),
    beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
  });
  return true;
}
