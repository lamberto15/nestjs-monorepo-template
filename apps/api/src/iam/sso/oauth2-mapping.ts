import { isIP } from 'node:net';
import { z } from 'zod';
import { addressAllowed } from '../../core/http/safe-fetch.js';
import { SsoRefused } from './sso-accounts.service.js';

/**
 * A plain OAuth 2.0 connection's mapping (docs/auth.md, "OAuth 2.0
 * connections"): where the provider's user-info answer holds the person.
 * Declarative, stored on the connection, so a provider needs no code of
 * its own.
 *
 * Custom: @nestjs/authentication models an OAuth 2.0 provider with a
 * `profile(userinfo)` function (its `github()` preset), set in code at
 * boot; a tenant's connection is a row added at runtime, so its profile is
 * this data, read by `mapUserinfo()` below.
 */

/** Never followed: what would reach an object's prototype instead of its own fields. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** A dot path (`data.open_id`; a numeric segment indexes an array). */
const path = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/,
    'A dot path of names (letters, digits, `_`, `-`), such as `data.open_id`.',
  )
  .refine(
    (value) => !value.split('.').some((part) => FORBIDDEN_SEGMENTS.has(part)),
    'No `__proto__`, `prototype` or `constructor` segment.',
  );

export const emailVerifiedModeSchema = z
  .union([
    z
      .object({
        path: path.describe(
          'A field of the user object that must be the boolean `true`.',
        ),
      })
      .strict(),
    z.literal('verified-domains'),
    z.literal('never'),
  ])
  .describe(
    'Whether the provider vouches for the address: `{ "path" }` (a field that must be `true`), `"verified-domains"` (trusted because its domain is one the tenant verified, as a SAML assertion is), or `"never"` (a first sign-in is refused, `email_unverified`).',
  );

export const oauth2MappingSchema = z
  .object({
    root: path
      .optional()
      .describe(
        'Where the user object is in the answer (`data` for Lark); the whole answer when absent.',
      ),
    subject: path.describe(
      "The provider's stable id of the person (a string or a number), in the user object.",
    ),
    email: path.optional().describe('The address, in the user object.'),
    name: path.optional(),
    picture: path
      .optional()
      .describe('Read, not stored yet: accounts have no picture.'),
    groups: path
      .optional()
      .describe(
        'An array of strings, in the user object: the groups `roleMappings` read. None when absent.',
      ),
    emailVerified: emailVerifiedModeSchema.default('never'),
    errorCode: path
      .optional()
      .describe(
        'A field of the whole answer that marks a failure (Lark answers 200 with `code` not 0): a non-zero number or any other truthy value refuses the sign-in.',
      ),
  })
  .strict();
export type Oauth2Mapping = z.infer<typeof oauth2MappingSchema>;

export const OAUTH2_AUTH_METHODS = [
  'client_secret_post',
  'client_secret_basic',
  'none',
] as const;
export type Oauth2AuthMethod = (typeof OAUTH2_AUTH_METHODS)[number];

export const oauth2PresetSchema = z
  .object({
    name: z
      .literal('lark')
      .describe(
        'Lark (Feishu) v2. More presets may come for providers whose code exchange is not standard OAuth 2.0.',
      ),
    region: z
      .enum(['lark', 'feishu'])
      .default('lark')
      .describe('`lark` (larksuite.com) or `feishu` (feishu.cn).'),
  })
  .strict();
export type Oauth2Preset = z.infer<typeof oauth2PresetSchema>;

/** What a preset fills in: the connection's own fields, never a code path. */
export interface Oauth2Defaults {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  tokenEndpointAuthMethod: Oauth2AuthMethod;
  scopes: string[];
  mapping: Oauth2Mapping;
}

/**
 * The defaults of a preset. Lark/Feishu v2: the authorization page, the
 * RFC 6749 token endpoint (client id and secret in the body, PKCE), and
 * `user_info`, which answers `{ code, msg, data: { open_id, union_id,
 * name, avatar_url, email, enterprise_email, … } }`. The address mapped is
 * `enterprise_email`, the one the tenant's administrator assigns in its
 * domain, trusted through the tenant's verified domains; the personal
 * `email` is never taken as verified.
 */
export function presetDefaults(preset: Oauth2Preset): Oauth2Defaults {
  const [accounts, open] =
    preset.region === 'feishu'
      ? ['https://accounts.feishu.cn', 'https://open.feishu.cn']
      : ['https://accounts.larksuite.com', 'https://open.larksuite.com'];
  return {
    authorizationEndpoint: `${accounts}/open-apis/authen/v1/authorize`,
    tokenEndpoint: `${open}/open-apis/authen/v2/oauth/token`,
    userinfoEndpoint: `${open}/open-apis/authen/v1/user_info`,
    tokenEndpointAuthMethod: 'client_secret_post',
    scopes: [],
    mapping: {
      root: 'data',
      subject: 'open_id',
      email: 'enterprise_email',
      name: 'name',
      picture: 'avatar_url',
      emailVerified: 'verified-domains',
      errorCode: 'code',
    },
  };
}

/** The value at a dot path, own fields only; undefined when any step is missing. */
export function valueAt(source: unknown, dotPath: string): unknown {
  let current: unknown = source;
  for (const segment of dotPath.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return undefined;
    }
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      Object.hasOwn(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Who the user-info answer names, before the account rules (SsoAccounts). */
export interface MappedUser {
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  groups?: string[];
}

const MAX_SUBJECT_LENGTH = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The person in a user-info answer, by the connection's mapping, or
 * SsoRefused: `userinfo_malformed` (not an object, no user object at
 * `root`, a subject that isn't a string or a number), `userinfo_error:<code>`
 * (`errorCode` set), `no_stable_subject`.
 *
 * `emailVerified` in the `verified-domains` mode is true here: the account
 * rules (SsoAccounts.resolve) refuse an address outside the tenant's
 * verified domains before they read it, as for SAML.
 */
export function mapUserinfo(body: unknown, mapping: Oauth2Mapping): MappedUser {
  if (!isRecord(body)) {
    throw new SsoRefused('userinfo_malformed');
  }
  if (mapping.errorCode) {
    const code = valueAt(body, mapping.errorCode);
    const failed = typeof code === 'number' ? code !== 0 : Boolean(code);
    if (failed) {
      throw new SsoRefused(`userinfo_error:${String(code).slice(0, 40)}`);
    }
  }
  const user = mapping.root ? valueAt(body, mapping.root) : body;
  if (!isRecord(user)) {
    throw new SsoRefused('userinfo_malformed');
  }
  const rawSubject = valueAt(user, mapping.subject);
  let subject: string | undefined;
  if (typeof rawSubject === 'string') {
    subject = rawSubject.trim() ? rawSubject : undefined;
  } else if (typeof rawSubject === 'number' && Number.isFinite(rawSubject)) {
    subject = String(rawSubject);
  } else if (rawSubject !== undefined && rawSubject !== null) {
    throw new SsoRefused('userinfo_malformed');
  }
  if (!subject) {
    throw new SsoRefused('no_stable_subject');
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new SsoRefused('userinfo_malformed');
  }
  const mode = mapping.emailVerified ?? 'never';
  const groups = mapping.groups ? valueAt(user, mapping.groups) : undefined;
  return {
    subject,
    email: mapping.email ? text(valueAt(user, mapping.email)) : undefined,
    emailVerified:
      mode === 'verified-domains'
        ? true
        : mode === 'never'
          ? false
          : valueAt(user, mode.path) === true,
    name: mapping.name ? text(valueAt(user, mapping.name)) : undefined,
    picture: mapping.picture ? text(valueAt(user, mapping.picture)) : undefined,
    groups: Array.isArray(groups)
      ? groups
          .filter((group): group is string => typeof group === 'string')
          .map((group) => group.trim())
          .filter(Boolean)
      : undefined,
  };
}

/** Loopback host names and addresses: http, and these, only with SSO_ALLOW_LOOPBACK. */
const isLoopback = (host: string) =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  (isIP(host) === 4 && host.startsWith('127.')) ||
  host === '::1';

/**
 * What is wrong with an OAuth 2.0 endpoint, or undefined: https only;
 * http, and a loopback host, only with SSO_ALLOW_LOOPBACK (development,
 * tests); no credentials in it; never an IP address that is private,
 * link-local, a cloud metadata address or reserved. A host name is checked
 * where it resolves to at each request (core/http/safe-fetch.ts): this
 * refuses early what can be seen when the connection is saved.
 */
export function endpointProblem(
  value: string,
  allowLoopback: boolean,
): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Not a URL.';
  }
  if (url.username || url.password) {
    return 'No user name or password in it.';
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isLoopback(host)) {
    if (!allowLoopback) {
      return 'A loopback address (allowed only with SSO_ALLOW_LOOPBACK, in development).';
    }
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? undefined
      : 'An https:// URL.';
  }
  if (url.protocol !== 'https:') {
    return 'An https:// URL (http:// only on loopback, in development).';
  }
  if (isIP(host) && !addressAllowed(host, false)) {
    return 'A private, link-local, metadata or reserved address is refused.';
  }
  return undefined;
}
