import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { SECRET_VARIABLES } from '../../env.js';
import { createLogger } from './logging.js';
import {
  LogRedaction,
  logRedaction,
  REDACTED,
  SECRET_FIELDS,
  SECRET_HEADERS,
} from './redaction.js';

// Made up per run: what no line may contain.
const secret = () => `s3cr3t-${randomBytes(12).toString('base64url')}`;

// Built at runtime: the shapes a secret scanner refuses in a source file.
const databaseUrl = (password: string) =>
  ['postgres://app', password].join(':') + '@db.internal:5432/app';
const pemBlock = (body: string) =>
  ['-----BEGIN', 'PRIVATE KEY-----\n'].join(' ') +
  body +
  ['\n-----END', 'PRIVATE KEY-----'].join(' ');

/**
 * A logger whose lines are collected instead of written (`forceConsole`
 * sends them to console.log/console.error, which the test takes over).
 */
function capture(
  env: NodeJS.ProcessEnv,
  redaction: LogRedaction = logRedaction,
) {
  const lines: string[] = [];
  const take = (line: unknown) => {
    lines.push(String(line));
  };
  const log = vi.spyOn(console, 'log').mockImplementation(take);
  const error = vi.spyOn(console, 'error').mockImplementation(take);
  const logger = createLogger(
    { LOG_LEVEL: 'verbose', ...env },
    { forceConsole: true },
    redaction,
  );
  return {
    logger,
    lines,
    text: () => lines.join('\n'),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

describe.each([
  ['json', { LOG_FORMAT: 'json' }],
  ['text', { LOG_FORMAT: 'text' }],
] as const)('the logger in %s mode', (_mode, env) => {
  let captured: ReturnType<typeof capture>;
  beforeEach(() => {
    captured = capture(env);
  });
  afterEach(() => captured.restore());

  it.each(SECRET_HEADERS)('masks the %s header in a logged object', (name) => {
    const value = secret();
    const header = name.replace(
      /(^|-)([a-z])/g,
      (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`,
    );
    captured.logger.log('request', {
      headers: { [name]: value, host: 'api.example.com' },
    });
    captured.logger.warn('request', { headers: { [header]: value } });
    expect(captured.text()).not.toContain(value);
    expect(captured.text()).toContain(REDACTED);
    expect(captured.text()).toContain('api.example.com');
  });

  it.each(SECRET_FIELDS.filter((field) => !field.includes('.')))(
    'masks the %s field at any depth',
    (field) => {
      const value = secret();
      captured.logger.log('top level', { [field]: value });
      captured.logger.log('nested', { body: { user: { [field]: value } } });
      captured.logger.log('in a list', { items: [{ [field]: value }] });
      captured.logger.log({ [field.toUpperCase()]: value });
      expect(captured.text()).not.toContain(value);
      expect(captured.lines).toHaveLength(4);
      for (const line of captured.lines) {
        expect(line).toContain(REDACTED);
      }
    },
  );

  it('masks a two-factor or OIDC code only where it is one (body, query)', () => {
    const code = '123456';
    captured.logger.log('sign-in', {
      body: { email: 'a@example.com', code },
      query: { code: `oidc-${code}` },
    });
    captured.logger.warn('refused', { code: 'validation_failed' });
    expect(captured.lines[0]).not.toContain(code);
    expect(captured.lines[1]).toContain('validation_failed');
  });

  it("masks the environment's secret variables when a config object is logged", () => {
    const value = secret();
    expect(SECRET_VARIABLES).toContain('JWT_SECRET');
    captured.logger.log('config', {
      JWT_SECRET: value,
      DATABASE_URL: databaseUrl(value),
      PORT: '3000',
    });
    expect(captured.text()).not.toContain(value);
    expect(captured.text()).toContain('3000');
  });

  it("masks what the logger's own option leaves alone: credentials inside a string message", () => {
    const token = secret();
    const basic = Buffer.from(`user:${token}`).toString('base64');
    captured.logger.log(`fetch failed with Authorization: Bearer ${token}`);
    captured.logger.log(`proxy refused Basic ${basic}`);
    captured.logger.log(`could not connect to ${databaseUrl(token)}`);
    captured.logger.log(`refreshing with refreshToken=${token} for a user`);
    captured.logger.log(`cookie: __Host-sid=${token}; Path=/; HttpOnly`);
    captured.logger.log(`set to __Host-sid=${token}; Path=/; HttpOnly`);
    captured.logger.log(
      `a JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${token}.abcdefghijklmnop`,
    );
    captured.logger.log(pemBlock(token));
    expect(captured.text()).not.toContain(token);
    expect(captured.text()).not.toContain(basic);
    expect(captured.text()).toContain(`Authorization: Bearer ${REDACTED}`);
    expect(captured.text()).not.toContain(`${REDACTED}]`);
    expect(captured.text()).toContain(databaseUrl(REDACTED));
    expect(captured.text()).toContain(`refreshToken=${REDACTED} for a user`);
    expect(captured.text()).toContain(`cookie: ${REDACTED}; Path=/`);
    expect(captured.text()).toContain(`__Host-sid=${REDACTED}; Path=/`);
  });

  it("masks an error's message and stack", () => {
    const token = secret();
    const error = new Error(`upstream said Bearer ${token} is expired`);
    error.stack = `Error: upstream said Bearer ${token} is expired\n    at fetch (password=${token})`;
    captured.logger.error(error);
    captured.logger.error('failed', error.stack);
    captured.logger.error(new Error('wrapped', { cause: { apiKey: token } }));
    expect(captured.text()).not.toContain(token);
    expect(captured.text()).toContain('is expired');
  });

  it('leaves ordinary lines alone', () => {
    captured.logger.log('POST /v1/notes 201', {
      requestId: 'req-1234567890',
      durationMs: 12.5,
      tokenCount: 42,
      maxTokens: 100,
      author: 'ada',
    });
    captured.logger.log('The password must have 8 characters at least');
    expect(captured.text()).not.toContain(REDACTED);
    expect(captured.text()).toContain('42');
    expect(captured.text()).toContain('100');
  });
});

describe('the registry', () => {
  it('takes declarations until the logger is built, then refuses them', () => {
    const registry = new LogRedaction();
    registry.declareFields('ssn', 'card.number');
    registry.declareHeaders('X-Internal-Token');
    registry.declarePatterns(/acct_[a-z0-9]{8}/);
    expect(registry.paths()).toEqual(
      expect.arrayContaining(['ssn', 'card.number', 'x-internal-token']),
    );
    expect(registry.keys()).not.toContain('card.number');
    expect(registry.patterns().at(-1)?.flags).toContain('g');

    const captured = capture({ LOG_FORMAT: 'json' }, registry);
    try {
      captured.logger.log('late', {
        ssn: 'value-1',
        card: { number: 'value-2' },
        note: 'acct_abcd1234 and acct_efgh5678',
      });
      expect(captured.text()).not.toMatch(/value-[12]|acct_/);
      expect(() => registry.declareFields('later')).toThrow(/import time/);
      expect(() => registry.declareHeaders('x-later')).toThrow(/import time/);
      expect(() => registry.declarePatterns(/later/)).toThrow(/import time/);
    } finally {
      captured.restore();
    }
  });

  it("holds the app's declarations: the environment's secret variables", () => {
    expect(logRedaction.keys()).toEqual(
      expect.arrayContaining([
        ...SECRET_VARIABLES,
        'authorization',
        'password',
      ]),
    );
  });

  it('redacts a text that is not a log line (a failure reason) the same way', () => {
    const token = secret();
    expect(
      logRedaction.redactText(`Request failed: Authorization: Bearer ${token}`),
    ).toBe(`Request failed: Authorization: Bearer ${REDACTED}`);
    expect(logRedaction.redactText('nothing here')).toBe('nothing here');
  });

  it('is what Nest resolves as the application logger', () => {
    const captured = capture({ LOG_FORMAT: 'json' });
    try {
      Logger.overrideLogger(captured.logger);
      const value = secret();
      new Logger('Test').log('through Nest', { password: value });
      expect(captured.text()).not.toContain(value);
      expect(captured.text()).toContain(REDACTED);
    } finally {
      Logger.overrideLogger(false);
      captured.restore();
    }
  });
});

describe('redactValue', () => {
  it('masks a secret by name at any depth, in any case, and in a text', () => {
    const password = secret();
    const token = secret();
    const value = logRedaction.redactValue({
      topic: 'mail.send',
      headers: { Authorization: `Bearer ${token}`, 'X-Request': 'r1' },
      payload: {
        user: { Password: password },
        note: `Request failed: refreshToken=${token}`,
        list: [{ apiKey: token }],
      },
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain(password);
    expect(text).not.toContain(token);
    expect(value).toMatchObject({
      topic: 'mail.send',
      headers: { Authorization: REDACTED, 'X-Request': 'r1' },
      payload: { user: { Password: REDACTED } },
    });
  });

  it('masks a dotted path only under its parent', () => {
    expect(
      logRedaction.redactValue({
        body: { code: '123456' },
        error: { code: 'not_found' },
      }),
    ).toEqual({ body: { code: REDACTED }, error: { code: 'not_found' } });
  });

  it('reduces an error to its name and message, never its stack', () => {
    const token = secret();
    const failure = new TypeError(`bad Authorization: Bearer ${token}`);
    const value = logRedaction.redactValue({ failure });
    expect(value).toEqual({
      failure: {
        name: 'TypeError',
        message: `bad Authorization: Bearer ${REDACTED}`,
      },
    });
    expect(JSON.stringify(value)).not.toContain(' at ');
  });

  it('drops the frames of a stack trace in a text and cuts a long one', () => {
    const text = 'Boom: it broke\n    at run (/app/dist/x.js:1:1)\n    at next';
    expect(logRedaction.redactString(text)).toBe('Boom: it broke');
    const long = 'x'.repeat(5000);
    const cut = logRedaction.redactString(long, 100);
    expect(cut).toHaveLength(101);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('masks a secret that sits at the cut', () => {
    // 90 characters, then "Bearer " and a 40-character token: the cut (100)
    // falls inside the token.
    const token = randomBytes(30).toString('base64url');
    expect(token).toHaveLength(40);
    const text = `${'a'.repeat(89)} Bearer ${token}`;
    const result = logRedaction.redactString(text, 100);
    expect(result).not.toContain(token.slice(0, 4));
    expect(result).toContain('Bearer ');
  });

  it('masks a private key the bound cut off, or that was never closed', () => {
    const body = randomBytes(30).toString('base64');
    const open = `before ${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n${body}`;
    const result = logRedaction.redactString(open);
    expect(result).toBe(`before ${REDACTED}`);
  });

  it('masks a name that ends with a declared one: snake_case, kebab-case, prefixed', () => {
    const value = secret();
    const masked = logRedaction.redactValue({
      access_token: value,
      refresh_token: value,
      client_secret: value,
      api_key: value,
      private_key: value,
      id_token: value,
      'x-auth-token': value,
      'x-amz-security-token': value,
      'stripe-signature': value,
      besid: 'kept',
      hotp: 'kept',
      fencingToken: 7,
      topic: 'kept',
    }) as Record<string, unknown>;
    const { besid, hotp, fencingToken, topic, ...rest } = masked;
    expect(Object.values(rest).every((v) => v === REDACTED)).toBe(true);
    expect(Object.keys(rest)).toHaveLength(9);
    // Short names (a letter or two off a common word) and numbers stay.
    expect({ besid, hotp, fencingToken, topic }).toEqual({
      besid: 'kept',
      hotp: 'kept',
      fencingToken: 7,
      topic: 'kept',
    });
  });

  it('shows bytes as their size, and an error name masked and cut', () => {
    expect(
      logRedaction.redactValue({
        buffer: Buffer.alloc(12),
        view: new Uint8Array(3),
      }),
    ).toEqual({ buffer: '[binary 12 bytes]', view: '[binary 3 bytes]' });
    const failure = new Error('x');
    failure.name = `Odd ${'n'.repeat(500)}`;
    const named = logRedaction.redactValue(failure) as { name: string };
    expect(named.name).toHaveLength(101);
  });

  it('bounds depth, width and size, and leaves the input alone', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i++) {
      deep = { next: deep };
    }
    expect(JSON.stringify(logRedaction.redactValue(deep))).toContain('[…]');
    const wide = logRedaction.redactValue(
      Array.from({ length: 1000 }, (_, i) => i),
    ) as unknown[];
    expect(wide).toHaveLength(100);
    const input = { password: 'x', nested: { a: 1 } };
    logRedaction.redactValue(input);
    expect(input.password).toBe('x');
  });

  it('sees a name declared later (a registry of its own)', () => {
    const registry = new LogRedaction({ headers: [], fields: ['one'] });
    expect(registry.redactValue({ one: 1, two: 2 })).toEqual({
      one: REDACTED,
      two: 2,
    });
    registry.declareFields('two');
    expect(registry.redactValue({ one: 1, two: 2 })).toEqual({
      one: REDACTED,
      two: REDACTED,
    });
  });
});
