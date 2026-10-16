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
