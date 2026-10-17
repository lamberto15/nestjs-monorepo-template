import { z } from 'zod';
import { appPath } from '../../app-dir.js';
import { secretRegistry } from './secret-files.js';

/**
 * Helpers for the environment schemas (`*.env.ts`). Variables always arrive
 * as strings, and `FOO=` in a .env file means "not set".
 */

const unsetIfEmpty = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** An optional string: unset or empty is `undefined`. */
export const optional = () =>
  z.preprocess(unsetIfEmpty, z.string().trim().optional());

/**
 * Marks a variable as a secret (a password, key or token, or a URL with a
 * password in it): it can also come from a file, `X_FILE`
 * (secret-files.ts), and its value never appears in a validation error.
 * Wraps the variable's whole schema, outermost: `secret(optional())`.
 * SECRET_VARIABLES (env.ts) lists them all.
 */
export const secret = <Schema extends z.ZodType>(schema: Schema) => {
  secretRegistry.add(schema);
  return schema;
};

/** A string with a default, used when unset or empty. */
export const withDefault = (fallback: string) =>
  z.preprocess(unsetIfEmpty, z.string().trim().default(fallback));

/**
 * A path with a default; a relative one resolves against the app's directory
 * (`apps/api`, `/app` in the image: src/app-dir.ts), not the shell's.
 */
export const pathWithDefault = (fallback: string) =>
  withDefault(fallback).transform(appPath);

/** `on` or `off`, as a boolean. */
export const flag = (fallback: 'on' | 'off') =>
  z
    .preprocess(unsetIfEmpty, z.enum(['on', 'off']).default(fallback))
    .transform((value) => value === 'on');

/** One of a fixed set of words; unset or empty, the fallback. */
export const choice = <const T extends [string, ...string[]]>(
  values: T,
  fallback: T[number],
) => z.preprocess(unsetIfEmpty, z.enum(values).default(fallback));

/** A comma-separated list, as an array (empty when unset). */
export const list = () =>
  z.preprocess(unsetIfEmpty, z.string().optional()).transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** An absolute http(s) URL without a trailing slash. */
export const baseUrl = (fallback?: string) =>
  z
    .preprocess(
      unsetIfEmpty,
      fallback === undefined ? z.url().optional() : z.url().default(fallback),
    )
    .transform((value) => value?.replace(/\/+$/, ''));

/** Whether `zone` is an IANA time zone this runtime knows (`Europe/Berlin`, `UTC`). */
export function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
