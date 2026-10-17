import { z } from 'zod';

/**
 * Whether a `redirect` value is a path of this app: relative, same origin.
 * Anything else (`https://evil.example`, `//evil.example`, `/\evil.example`,
 * `javascript:…`) is an open redirect and is refused.
 */
export function isSafeRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return false;
  }
  // `//host` and `/\host` are protocol-relative to browsers.
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return false;
  }
  // Control characters (a tab or newline inside `/\t/host`) are stripped by
  // URL parsers: refuse them rather than reason about it.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  try {
    const base = 'https://app.invalid';
    return new URL(value, base).origin === base;
  } catch {
    return false;
  }
}

/** A safe redirect target, else `fallback`. */
export function safeRedirect(value: unknown, fallback = '/'): string {
  return isSafeRedirect(value) ? value : fallback;
}

/**
 * The `?redirect=` of the sign-in pages: kept only when it is a path of this
 * app (an unsafe value is dropped, never followed).
 */
export const redirectSearchSchema = z.object({
  redirect: z.string().refine(isSafeRedirect).optional().catch(undefined),
});
