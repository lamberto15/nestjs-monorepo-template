import { z } from 'zod';
import { trimEnd } from '../text/trim.js';

/**
 * Where a browser may be sent back to after a sign-in (`redirectTo`): a path
 * of the web app, never another site (an open redirect, reachable from a
 * link the app mailed). One rule for every route that takes one, stores one
 * or answers one (docs/auth.md, `redirectTo`).
 *
 * Custom: @nestjs/authentication applies the same rule to what it stores
 * (`safeRedirectPath`, utils/crypto.util.js) but does not export it, and it
 * drops a refused value silently; the routes refuse it (400) and re-check
 * a stored value before answering or redirecting to it.
 */

/** As the package's own limit: a login or a link stores it until used. */
export const REDIRECT_PATH_MAX_LENGTH = 2048;

/** Any base: a path that passes the rules below resolves within it, whatever it is. */
const PROBE = new URL('https://redirect.invalid/');

/** `%XX` decoded byte by byte (malformed escapes kept), for the check of a client that decodes once. */
const decodedOnce = (value: string) =>
  value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/**
 * Whether `value` is a same-origin relative path: starts with exactly one
 * `/`; only printable ASCII (no space, control or non-ASCII character: a
 * URL parser drops a tab or a newline, so `/\t/evil` would mean `//evil`);
 * no `\` (a URL parser reads it as `/`, so `/\evil` means `//evil`); no
 * scheme (`javascript:`, `https:`: they don't start with `/`); at most
 * REDIRECT_PATH_MAX_LENGTH characters. A client that percent-decodes it
 * once must not get one of those either (`/%09/evil`, `/%5Cevil`,
 * `/%2Fevil`). Last, resolved as a URL, it must stay on the base's origin,
 * with a path that doesn't start with `//` (`/.//evil` resolves to
 * `//evil`, which a client re-reading the path would follow off-site).
 */
export function isSafeRedirectPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > REDIRECT_PATH_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value) ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return false;
  }
  const decoded = decodedOnce(value);
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.startsWith('//')) {
    return false;
  }
  try {
    const url = new URL(value, PROBE);
    return url.origin === PROBE.origin && !url.pathname.startsWith('//');
  } catch {
    return false;
  }
}

/**
 * The web app's URL for `value`: a safe path (`isSafeRedirectPath`), or an
 * absolute URL on the web app's origin whose path is one, resolved against
 * `webUrl` and checked to stay on its origin; anything else (missing, a
 * value stored before these rules, another site) is the web app's root.
 * Never throws: the browser is navigating, a problem response would be its
 * landing page.
 */
export function webAppUrl(value: unknown, webUrl: string): URL {
  const web = new URL(`${trimEnd(webUrl, '/')}/`);
  const root = new URL('/', web);
  let path = value;
  if (typeof value === 'string' && !value.startsWith('/')) {
    // An absolute URL (the package's `redirectAfterLogin`): the web app's own only.
    if (!URL.canParse(value)) {
      return root;
    }
    const absolute = new URL(value);
    if (absolute.origin !== web.origin) {
      return root;
    }
    path = `${absolute.pathname}${absolute.search}${absolute.hash}`;
  }
  if (!isSafeRedirectPath(path)) {
    return root;
  }
  const url = new URL(path, web);
  return url.origin === web.origin ? url : root;
}

/** A `redirectTo` in a body or a query: refused (400 `validation_failed`) unless `isSafeRedirectPath`. */
export const redirectPath = z
  .string()
  .max(REDIRECT_PATH_MAX_LENGTH, { abort: true })
  // The part of the rule a pattern can say, for the OpenAPI document and its clients.
  .regex(/^\/(?![/\\])[\x21-\x5b\x5d-\x7e]*$/, {
    error: 'must start with one "/" and hold only printable ASCII, no "\\"',
    abort: true,
  })
  .refine(isSafeRedirectPath, {
    error:
      'must be a path of the web app: one leading "/", printable ASCII, no "\\", no scheme',
  })
  .meta({ example: '/inbox' });
