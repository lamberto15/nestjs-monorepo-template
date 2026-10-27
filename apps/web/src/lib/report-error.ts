import type { RootOptions } from 'react-dom/client';
import { isApiError } from '@nestjs-monorepo-template/api-client';

/**
 * The one place the web app reports an error it did not expect: React's root
 * callbacks, the window's uncaught errors and rejections, a query or mutation
 * failing with something that is not the API's answer, a route's error page.
 * Each gets a short report id, which the error page and the toast show so a
 * user can quote it. Logged to the console, and sent to the API
 * (`POST /v1/client-errors`, `core/http/http-setup.ts`'s same-origin check
 * lets it through with no sign-in needed), which logs it server-side; #751.
 *
 * Custom code: React, TanStack Router and the browser each offer a hook, not
 * a sink, and one error can reach several of them (an error a route's
 * boundary caught is React's `onCaughtError` and the error page's), so it is
 * reported once, under one id. A plain `fetch`, not the typed client
 * (`@/lib/api`): this is the path an error in the app's own request
 * machinery still has to go through, so it stays free of that machinery.
 */

/** Where an error was heard. */
export type ErrorSource =
  | 'uncaught'
  | 'caught'
  | 'recoverable'
  | 'window'
  | 'rejection'
  | 'request'
  | 'route';

const ids = new WeakMap<object, string>();
const reported = new WeakSet<object>();

// A loop that throws on every frame must not flood whatever `send` becomes:
// at most this many reports a minute; the rest keep their id, unsent.
const LIMIT = 20;
const WINDOW_MS = 60_000;
let sent: number[] = [];

/** Field limits of apps/api/src/platform/client-errors/client-errors.schemas.ts. */
const truncate = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) : text;

function send(id: string, source: ErrorSource, error: unknown) {
  console.error(`[${id}] ${source} error`, error);
  const message = error instanceof Error ? error.message : String(error);
  void fetch('/v1/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      source,
      message: truncate(message, 2000),
      stack:
        error instanceof Error && error.stack
          ? truncate(error.stack, 8000)
          : undefined,
      path: location.pathname,
    }),
    // Best effort: a failed report must never become one of its own.
  }).catch(() => {});
}

const newId = () => crypto.randomUUID().slice(0, 8);

/** An error's report id: the same for the same error object, wherever heard. */
export function reportIdOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return newId();
  }
  let id = ids.get(error);
  if (!id) {
    id = newId();
    ids.set(error, id);
  }
  return id;
}

/** Reports `error` (once per error object) and returns its report id. */
export function reportClientError(error: unknown, source: ErrorSource): string {
  const id = reportIdOf(error);
  if (typeof error === 'object' && error !== null) {
    if (reported.has(error)) {
      return id;
    }
    reported.add(error);
  }
  const now = Date.now();
  sent = sent.filter((at) => now - at < WINDOW_MS);
  if (sent.length < LIMIT) {
    sent.push(now);
    send(id, source, error);
  }
  return id;
}

/** Forgets what was reported (tests). */
export function resetErrorReports() {
  sent = [];
}

/**
 * Noise, not a fault of the app's: the API's own answers (it logged them, by
 * request id), the browser's ResizeObserver notice, and a cross-origin
 * script's error the browser hides ("Script error.", the CAPTCHA's).
 */
function isNoise(error: unknown, message?: string) {
  if (isApiError(error)) {
    return true;
  }
  const text =
    message ?? (error instanceof Error ? error.message : String(error));
  return /^ResizeObserver loop|^Script error\.?$/.test(text);
}

/**
 * A fetch that never reached the API (offline, DNS, a dropped connection):
 * the browsers word their TypeError differently. Not reported: the user is
 * told to check the connection.
 */
export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(
      error.message,
    )
  );
}

/**
 * createRoot's error callbacks. React's defaults log, and send the uncaught
 * and recoverable ones to the window's `error` event as well; these replace
 * them, so each is reported (and logged) once, here.
 */
export const rootErrorHandlers = {
  onUncaughtError: (error) => void reportClientError(error, 'uncaught'),
  onCaughtError: (error) => void reportClientError(error, 'caught'),
  onRecoverableError: (error) => void reportClientError(error, 'recoverable'),
} satisfies RootOptions;

/** The window's uncaught errors and unhandled rejections; returns the removal. */
export function listenForUncaughtErrors(target: Window = window) {
  const onError = (event: ErrorEvent) => {
    if (!isNoise(event.error, event.message)) {
      reportClientError(event.error ?? event.message, 'window');
    }
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isNoise(event.reason) && !isNetworkError(event.reason)) {
      reportClientError(event.reason, 'rejection');
    }
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
