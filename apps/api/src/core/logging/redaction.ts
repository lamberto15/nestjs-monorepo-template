/**
 * What never reaches a log line or an error report: one declared list, read
 * by everything that masks.
 *
 * - **Keys** (headers and fields): `createLogger()` hands them to Nest's
 *   `ConsoleLogger` as its `redact` option, which masks a property of that
 *   name at any depth of a structured param or a logged object (an error's
 *   `cause` included), and `observe.ts` hands them to NestJS Observe as
 *   `redaction.keys` for the errors and requests it captures.
 * - **Patterns**: what a secret looks like inside free text (a bearer
 *   credential, a JWT, a URL's password, a `name=value` pair), because the
 *   logger's own redaction leaves string messages, error messages and stack
 *   traces as they are. `createLogger()` runs them over every line it
 *   writes (`redactText()`), and Observe gets them as `redaction.patterns`.
 *
 * Declared at import time, from module scope, so the list is complete when
 * `createLogger()` snapshots it (main.ts): `env.ts` adds every `secret()`
 * variable, `iam/auth/api-keys.ts` the API keys' shape. A declaration after
 * the logger was built throws, so it cannot silently protect nothing.
 *
 * The encrypted-column registry (roadmap item 5, core/encryption) declares
 * each encrypted column's name here (`encrypted()`); audit `changes`,
 * revisions, exports and webhooks consult it too (docs/encryption.md). The permission catalog's
 * `sensitive` field flag is per subject (audit entries) and stays apart:
 * log redaction is by name wherever the name appears, so only names that
 * always hold a secret belong here.
 */

/** What a masked value becomes (the same word as Nest's and Observe's defaults). */
export const REDACTED = '[REDACTED]';

/**
 * The request and response headers that carry a credential. The ones the
 * app reads (sessions: `cookie`/`set-cookie`; tokens and API keys:
 * `authorization`; bot protection: `x-captcha-token`; incoming webhooks:
 * `webhook-signature`, Standard Webhooks) and the names a proxy, a
 * provider or a later feature commonly use. Lower case: Nest and Observe
 * compare case-insensitively. `Idempotency-Key` is not here: it is a
 * client-chosen id, scoped to the caller, no use to anyone else.
 */
export const SECRET_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-captcha-token',
  'x-csrf-token',
  'x-xsrf-token',
  'webhook-signature',
  'x-signature',
  'x-hub-signature',
  'x-hub-signature-256',
] as const;

/**
 * The body, query and object fields that hold a secret, wherever they
 * appear: the DTOs' names (sign-in, tokens, two-factor, magic links, API
 * clients), the packages' (`@nestjs/authentication`'s sessions and tokens)
 * and the providers' (SNS confirmations carry the subscription token in
 * `Token` and `SubscribeURL`). A dotted path masks the key only under that
 * parent: `code` is a two-factor code in a request body (`body.code`) and
 * the OIDC authorization code in a query string (`query.code`), but also
 * every error's `code`, which the logs need.
 */
export const SECRET_FIELDS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordConfirmation',
  'passphrase',
  'secret',
  'clientSecret',
  'pendingSecret',
  'secretKey',
  'privateKey',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'recoveryCode',
  'recoveryCodes',
  'totp',
  'otp',
  'signature',
  'cookie',
  'cookies',
  'sessionId',
  'sid',
  'jwt',
  'authorization',
  'credentials',
  'subscribeUrl',
  'unsubscribeUrl',
  'body.code',
  'query.code',
] as const;

/** Escapes a name for use inside a regular expression. */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The registry: the headers, fields and patterns declared so far, and the
 * text redaction built from them. One instance for the app (`logRedaction`);
 * tests make their own.
 */
export class LogRedaction {
  private readonly headers = new Set<string>();
  private readonly fields = new Set<string>();
  private readonly extraPatterns: RegExp[] = [];
  private frozenBy?: string;
  private textRules?: TextRule[];
  private lowerNames?: Set<string>;
  private suffixes?: string[];

  constructor({
    headers = SECRET_HEADERS,
    fields = SECRET_FIELDS,
  }: {
    headers?: readonly string[];
    fields?: readonly string[];
  } = {}) {
    for (const header of headers) {
      this.headers.add(header.toLowerCase());
    }
    for (const field of fields) {
      this.fields.add(field);
    }
  }

  /** Headers whose value is a credential (compared case-insensitively). */
  declareHeaders(...names: string[]) {
    this.assertOpen(names);
    for (const name of names) {
      this.headers.add(name.toLowerCase());
    }
    this.textRules = undefined;
    this.lowerNames = undefined;
    this.suffixes = undefined;
    return this;
  }

  /**
   * Fields (object keys, body or query fields, environment variables) whose
   * value is a secret, at any depth; a dotted path (`body.code`) masks the
   * last key only under those parents.
   */
  declareFields(...names: string[]) {
    this.assertOpen(names);
    for (const name of names) {
      this.fields.add(name);
    }
    this.textRules = undefined;
    this.lowerNames = undefined;
    this.suffixes = undefined;
    return this;
  }

  /**
   * What a secret looks like in free text: the whole match is replaced
   * (use a lookbehind to keep an identifying prefix). Applied globally,
   * whether or not the pattern says `g`.
   */
  declarePatterns(...patterns: RegExp[]) {
    this.assertOpen(patterns.map(String));
    for (const pattern of patterns) {
      this.extraPatterns.push(
        pattern.global
          ? pattern
          : new RegExp(pattern.source, `${pattern.flags}g`),
      );
    }
    this.textRules = undefined;
    return this;
  }

  /** The key names and dotted paths, for Nest's `redact` option. */
  paths(): string[] {
    return [...this.headers, ...this.fields];
  }

  /** The plain key names (no dotted paths), for Observe's `redaction.keys`. */
  keys(): string[] {
    return this.paths().filter((path) => !path.includes('.'));
  }

  /** Every text pattern, the built-in ones first, for Observe's `redaction.patterns`. */
  patterns(): RegExp[] {
    return this.rules().map((rule) => rule.pattern);
  }

  /**
   * Masks the secrets the patterns find in a text: a log line, an error
   * message, a job's failure reason. Returns the text itself when nothing
   * matched.
   */
  redactText(text: string): string {
    let result = text;
    for (const rule of this.rules()) {
      result = result.replace(rule.pattern, rule.replace);
    }
    return result;
  }

  /**
   * A value made safe to show: for a browser (the operations dashboard),
   * not a log line. Walks objects and arrays and masks every property
   * named like a declared header or field (any case, a dotted path under
   * its parent), runs the text patterns over every string and cuts it at
   * `maxString` characters, and turns an Error into `{ name, message }`:
   * never its stack, which holds file paths and whatever the engine put in
   * it. Depth, array length and key count are bounded too, so one huge
   * payload cannot fill a stream. Returns a new value; the input is left
   * alone.
   */
  redactValue(value: unknown, options: RedactValueOptions = {}): unknown {
    const limits = { ...VALUE_LIMITS, ...options };
    return this.redactNode(value, limits, { nodes: limits.maxNodes }, 0);
  }

  /**
   * `redactValue()` for a text: a stack trace's frames dropped, the patterns,
   * then the cut.
   */
  redactString(text: string, maxString = VALUE_LIMITS.maxString): string {
    const frames = text.search(/\n\s+at \S/);
    const message = frames === -1 ? text : text.slice(0, frames);
    // Cut first, at a bound well past the final one, so a huge string costs
    // little; the secret that straddles the cut sits beyond the final one.
    const head = message.slice(0, maxString * 4);
    // A private key cut off by the bound (or never closed) has no END line
    // for the pattern to find: from its BEGIN line to the end of what was read.
    const masked = this.redactText(head).replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*$/,
      REDACTED,
    );
    return masked.length > maxString || head.length < message.length
      ? `${masked.slice(0, maxString)}…`
      : masked;
  }

  private redactNode(
    value: unknown,
    limits: Required<RedactValueOptions>,
    budget: { nodes: number },
    depth: number,
    parent?: string,
  ): unknown {
    if (typeof value === 'string') {
      return this.redactString(value, limits.maxString);
    }
    if (value === null || typeof value !== 'object') {
      // Numbers, booleans, undefined; a bigint or symbol has no JSON form.
      return typeof value === 'bigint' || typeof value === 'symbol'
        ? String(value)
        : value;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return `[binary ${value.byteLength} bytes]`;
    }
    if (value instanceof Error) {
      return {
        name: this.redactString(value.name, 100),
        message: this.redactString(value.message, limits.maxString),
      };
    }
    if (depth >= limits.maxDepth || --budget.nodes < 0) {
      return '[…]';
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, limits.maxItems)
        .map((item) =>
          this.redactNode(item, limits, budget, depth + 1, parent),
        );
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    const result: Record<string, unknown> = {};
    let keys = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (++keys > limits.maxItems) {
        break;
      }
      const item = (value as Record<string, unknown>)[key];
      result[key] = this.isSecretKey(key, parent, item)
        ? REDACTED
        : this.redactNode(item, limits, budget, depth + 1, key);
    }
    return result;
  }

  /**
   * Whether a property of this name (under this parent) holds a secret by
   * name: a declared name or dotted path, or, for a text value, a name that
   * ends with a declared one once case, `_` and `-` are ignored
   * (`access_token`, `client_secret`, `x-auth-token`, `stripe-signature`).
   * The ending is for names of four letters or more (`sid` and `otp` would
   * match too much) and for texts only: a `fencingToken` number is no secret.
   */
  private isSecretKey(
    key: string,
    parent: string | undefined,
    value: unknown,
  ): boolean {
    this.lowerNames ??= new Set(this.paths().map((path) => path.toLowerCase()));
    const name = key.toLowerCase();
    if (
      this.lowerNames.has(name) ||
      (parent !== undefined &&
        this.lowerNames.has(`${parent.toLowerCase()}.${name}`))
    ) {
      return true;
    }
    if (typeof value !== 'string') {
      return false;
    }
    this.suffixes ??= [
      ...new Set(
        [...this.lowerNames]
          .filter((path) => !path.includes('.'))
          .map((path) => path.replace(/[_-]/g, ''))
          .filter((path) => path.length >= 4),
      ),
    ];
    const plain = name.replace(/[_-]/g, '');
    return this.suffixes.some((suffix) => plain.endsWith(suffix));
  }

  /**
   * Closes the registry: `createLogger()` calls it once the logger holds
   * the list, so a declaration that came too late to be in it fails loudly.
   */
  freeze(by: string) {
    this.frozenBy ??= by;
  }

  private assertOpen(what: string[]) {
    if (this.frozenBy) {
      throw new Error(
        `Log redaction is declared at import time (module scope), before the logger is built: ${what.join(', ')} was declared after ${this.frozenBy}.`,
      );
    }
  }

  private rules(): TextRule[] {
    this.textRules ??= [
      ...builtInRules(this.textKeys()),
      ...this.extraPatterns.map(whole),
    ];
    return this.textRules;
  }

  /** The names a `name=value` pair in a text is masked by: headers, fields and the last key of a dotted path. */
  private textKeys(): string[] {
    const names = new Set<string>();
    for (const header of this.headers) {
      names.add(header);
    }
    for (const field of this.fields) {
      if (!field.includes('.')) {
        names.add(field);
      }
    }
    return [...names];
  }
}

/** What `redactValue()` keeps of a value. */
export interface RedactValueOptions {
  /** Longest string kept, in characters; a longer one is cut and ends with `…`. */
  maxString?: number;
  /** Deepest nesting kept; deeper becomes `[…]`. */
  maxDepth?: number;
  /** Most array items and object keys kept per level. */
  maxItems?: number;
  /** Most objects and arrays walked in all; the rest becomes `[…]`. */
  maxNodes?: number;
}

const VALUE_LIMITS: Required<RedactValueOptions> = {
  maxString: 1000,
  maxDepth: 6,
  maxItems: 100,
  maxNodes: 500,
};

interface TextRule {
  pattern: RegExp;
  replace: (...match: string[]) => string;
}

const whole = (pattern: RegExp): TextRule => ({
  pattern,
  replace: () => REDACTED,
});

/**
 * The built-in text rules, in the order they run. High precision over
 * reach: a rule that mangles ordinary lines gets switched off, and then
 * protects nothing. Anything that is an object goes through the key
 * redaction instead; these catch what was interpolated into a string.
 */
function builtInRules(keys: string[]): TextRule[] {
  // Longest first, so `accessToken` wins over `token` where both would match.
  const names = [...keys]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
  // Without a name the rule would match every pair: no names, no rule.
  // The value: one already masked (left as is), a scheme and its credential
  // (the scheme stays), a quoted string, or everything up to a separator.
  const bare = `[^\\s,;&}\\]"']+`;
  const value = `(\\[REDACTED\\]|(?:Bearer|Basic)\\s+(?:\\[REDACTED\\]|${bare})|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|${bare})`;
  // Between the separator and the value, the colour codes of an inspected
  // object in text mode (kept, as part of the separator).
  const separator = `(["']?\\s*[:=]\\s*(?:\\x1b\\[[0-9;]*m)*)`;
  const byName: TextRule[] = names
    ? [
        {
          pattern: new RegExp(
            `\\b([\\w-]*?(?:${names}))${separator}${value}`,
            'gi',
          ),
          replace: (_match, key: string, separator: string, found: string) => {
            if (found === REDACTED) {
              return `${key}${separator}${found}`;
            }
            const scheme = /^(Bearer|Basic)\s/i.exec(found)?.[1];
            if (scheme) {
              return `${key}${separator}${scheme} ${REDACTED}`;
            }
            const quote = found[0] === '"' || found[0] === "'" ? found[0] : '';
            return `${key}${separator}${quote}${REDACTED}${quote}`;
          },
        },
      ]
    : [];
  return [
    // PEM private keys first: they span lines, and the narrower rules
    // below would otherwise eat them piecemeal.
    whole(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    ),
    // The Authorization schemes (Bearer, Basic) and their credential. Before
    // the name=value rule, whose value would stop at the space after the scheme.
    {
      pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      replace: (_match, scheme: string) => `${scheme} ${REDACTED}`,
    },
    // A JWT on its own (an access token in a message).
    whole(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
    // The password of a URL (a database or Redis URL in a connection error).
    {
      pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+@/gi,
      replace: (_match, prefix: string) => `${prefix}${REDACTED}@`,
    },
    // A declared name (matched at the end of a longer one, as a reset
    // token's), then `=` or `:`, then the value up to a separator, or a
    // whole quoted string: a header line, a cookie pair, an environment
    // variable, a field of an inspected object or of a JSON line. The name
    // stays, so the line still says what was removed; a quoted value keeps
    // its quotes, so a JSON line stays JSON.
    ...byName,
  ];
}

/** The app's registry: declared at import time, snapshotted by `createLogger()`. */
export const logRedaction = new LogRedaction();

/** `logRedaction.redactValue()`, for what a browser is shown (the operations API). */
export const redactValue = (value: unknown, options?: RedactValueOptions) =>
  logRedaction.redactValue(value, options);

/** `logRedaction.redactString()`: a text masked and cut. */
export const redactString = (text: string, maxString?: number) =>
  logRedaction.redactString(text, maxString);

/** `logRedaction.redactText()`, for the places that build a text from an error (a job's failure reason). */
export const redactText = (text: string) => logRedaction.redactText(text);
