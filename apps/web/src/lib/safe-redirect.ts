import { z } from 'zod';

const base = 'https://app.invalid';

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * A `redirect` value as a path of this app (relative, same origin), in the
 * normalized form the URL parser gives it (`/a/../b` → `/b`), or undefined
 * when it isn't one. Refused: `https://evil.example`, `//evil.example`,
 * `/\evil.example`, `javascript:…`, control characters, and anything whose
 * normalized path starts with two slashes or a slash and a backslash, also
 * once percent-decoded (`/..//evil.example`, `/%2e%2e//evil.example`,
 * `/%2f%2fevil.example`, `/%5cevil.example`): a router or server that
 * decodes or re-normalizes it must not find a protocol-relative URL.
 */
export function normalizeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return undefined;
  }
  // Control characters (a tab or newline inside `/\t/host`) are stripped by
  // URL parsers: refuse them rather than reason about it.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  if (url.origin !== base) {
    return undefined;
  }
  const twoSlashes = /^[/\\]{2}/;
  if (
    twoSlashes.test(value) ||
    twoSlashes.test(url.pathname) ||
    twoSlashes.test(decoded(url.pathname))
  ) {
    return undefined;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Whether a `redirect` value is a path of this app (see normalizeRedirect). */
export function isSafeRedirect(value: unknown): value is string {
  return normalizeRedirect(value) !== undefined;
}

/** The normalized redirect target, else `fallback`. */
export function safeRedirect(value: unknown, fallback = '/'): string {
  return normalizeRedirect(value) ?? fallback;
}

/**
 * The `?redirect=` of the sign-in pages: kept, normalized, only when it is a
 * path of this app (an unsafe value is dropped, never followed).
 */
export const redirectSearchSchema = z.object({
  redirect: z
    .string()
    .transform((value, context) => {
      const path = normalizeRedirect(value);
      if (path === undefined) {
        context.addIssue({ code: 'custom', message: 'not a path of this app' });
        return z.NEVER;
      }
      return path;
    })
    .optional()
    .catch(undefined),
});
