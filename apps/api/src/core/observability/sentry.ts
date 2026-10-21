import { type LogRedaction, logRedaction } from '../logging/redaction.js';
import { sentryEnabled } from './telemetry.js';

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

/** Starts Sentry when `SENTRY_DSN` is set. */
export async function startSentry(env: NodeJS.ProcessEnv = process.env) {
  if (!sentryEnabled(env)) {
    return false;
  }
  const Sentry = await import('@sentry/nestjs');
  Sentry.init({
    dsn: env.SENTRY_DSN,
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
    tracesSampleRate: tracesSampleRate(env),
    beforeSend: (event) => scrub(event),
    beforeSendSpan: (span) => scrub(span),
    beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
  });
  return true;
}
