import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { envSchema, SECRET_VARIABLES } from '../../env.js';
import { featuresEnv } from '../../features/env.js';
import { optional, secret } from './env.helpers.js';
import {
  readSecretFiles,
  secretNames,
  secretValue,
  unusedFileVariables,
  withSecretFiles,
} from './secret-files.js';

// Made up per run: what an error must never contain.
const VALUE = `value-${crypto.randomUUID()}`;
const DB_URL = `postgres://db.internal:5432/${VALUE}`;

/** A read function over an in-memory file system. */
const files =
  (contents: Record<string, string>) =>
  (path: string): string => {
    if (!(path in contents)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return contents[path];
  };

describe('readSecretFiles', () => {
  it('reads X from the file X_FILE names', () => {
    const { values, problems } = readSecretFiles(
      { JWT_SECRET_FILE: '/run/secrets/jwt_secret' },
      ['JWT_SECRET'],
      files({ '/run/secrets/jwt_secret': VALUE }),
    );
    expect(problems).toEqual([]);
    expect(values).toEqual({ JWT_SECRET: VALUE });
  });

  it('leaves a variable without X_FILE to the environment', () => {
    const read = vi.fn();
    const { values, problems } = readSecretFiles(
      { JWT_SECRET: VALUE, JWT_SECRET_FILE: '  ' },
      ['JWT_SECRET'],
      read,
    );
    expect(problems).toEqual([]);
    expect(values).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses X and X_FILE both set, without reading the file', () => {
    const read = vi.fn();
    const { values, problems } = readSecretFiles(
      { JWT_SECRET: VALUE, JWT_SECRET_FILE: '/run/secrets/jwt_secret' },
      ['JWT_SECRET'],
      read,
    );
    expect(values).toEqual({});
    expect(problems).toEqual([
      {
        variable: 'JWT_SECRET_FILE',
        message: 'JWT_SECRET and JWT_SECRET_FILE are both set: keep one',
      },
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it('takes an empty X as unset, so X_FILE is used', () => {
    const { values, problems } = readSecretFiles(
      { JWT_SECRET: '', JWT_SECRET_FILE: '/s' },
      ['JWT_SECRET'],
      files({ '/s': VALUE }),
    );
    expect(problems).toEqual([]);
    expect(values.JWT_SECRET).toBe(VALUE);
  });

  it('names the variable and the path of a file it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-files-'));
    try {
      const { values, problems } = readSecretFiles(
        {
          JWT_SECRET_FILE: join(dir, 'missing'),
          // A directory: EISDIR.
          METRICS_TOKEN_FILE: dir,
        },
        ['JWT_SECRET', 'METRICS_TOKEN'],
      );
      expect(values).toEqual({});
      expect(problems).toEqual([
        {
          variable: 'JWT_SECRET_FILE',
          message: `can't read ${join(dir, 'missing')} (ENOENT)`,
        },
        {
          variable: 'METRICS_TOKEN_FILE',
          message: `can't read ${dir} (EISDIR)`,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never repeats a read error's message (it could quote the file)", () => {
    const { problems } = readSecretFiles(
      { JWT_SECRET_FILE: '/s' },
      ['JWT_SECRET'],
      () => {
        throw new Error(`unexpected ${VALUE}`);
      },
    );
    expect(problems).toEqual([
      { variable: 'JWT_SECRET_FILE', message: "can't read /s (unreadable)" },
    ]);
  });

  it('refuses an empty file: the secret did not arrive', () => {
    const { values, problems } = readSecretFiles(
      { JWT_SECRET_FILE: '/s' },
      ['JWT_SECRET'],
      files({ '/s': '\n' }),
    );
    expect(values).toEqual({});
    expect(problems).toEqual([
      { variable: 'JWT_SECRET_FILE', message: '/s is empty' },
    ]);
  });

  it.each([
    ['a newline', `${VALUE}\n`],
    ['CRLF', `${VALUE}\r\n`],
    ['several line breaks', `${VALUE}\n\r\n\n`],
  ])('drops the trailing line breaks (%s)', (_, contents) => {
    const { values } = readSecretFiles(
      { JWT_SECRET_FILE: '/s' },
      ['JWT_SECRET'],
      files({ '/s': contents }),
    );
    expect(values.JWT_SECRET).toBe(VALUE);
  });

  it('keeps the line breaks inside a value (a PEM block)', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const { values } = readSecretFiles(
      { JWT_SECRET_FILE: '/s' },
      ['JWT_SECRET'],
      files({ '/s': `${pem}\n` }),
    );
    expect(values.JWT_SECRET).toBe(pem);
  });

  it('reads only the secrets it is given', () => {
    const read = vi.fn();
    readSecretFiles({ PORT_FILE: '/port' }, ['JWT_SECRET'], read);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('withSecretFiles', () => {
  const schema = z.object({
    PORT: z.coerce.number().default(3000),
    TOKEN: secret(optional()),
    URL: secret(z.string().regex(/^postgres:\/\//, 'a postgres:// URL')),
  });

  it('lists the variables declared with secret()', () => {
    expect(secretNames(schema)).toEqual(['TOKEN', 'URL']);
  });

  it('validates the values from the files and puts them into process.env', () => {
    const processEnv: NodeJS.ProcessEnv = {
      TOKEN: '',
      TOKEN_FILE: '/token',
      URL_FILE: '/url',
    };
    const parsed = withSecretFiles(schema, {
      read: files({ '/token': `${VALUE}\n`, '/url': `${DB_URL}\r\n` }),
      processEnv,
    }).parse({ ...processEnv });
    expect(parsed).toEqual({ PORT: 3000, TOKEN: VALUE, URL: DB_URL });
    expect(processEnv).toMatchObject({ TOKEN: VALUE, URL: DB_URL });
  });

  it('validates again in the same process: X it set is not taken for both set', () => {
    const processEnv: NodeJS.ProcessEnv = { TOKEN_FILE: '/token', URL: DB_URL };
    const step = withSecretFiles(schema, {
      read: files({ '/token': `${VALUE}\n` }),
      processEnv,
    });
    step.parse({ ...processEnv });
    expect(step.parse({ ...processEnv }).TOKEN).toBe(VALUE);
  });

  it("reports every problem as an issue on X_FILE, with the schema's own, without the values", () => {
    const result = withSecretFiles(schema, {
      read: files({}),
      processEnv: {},
    }).safeParse({
      PORT: 'not-a-port',
      TOKEN: VALUE,
      TOKEN_FILE: '/token',
      URL_FILE: '/url',
    });
    expect(result.success).toBe(false);
    const issues = result.error!.issues.map(({ path, message }) => [
      path.join('.'),
      message,
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        ['TOKEN_FILE', 'TOKEN and TOKEN_FILE are both set: keep one'],
        ['URL_FILE', "can't read /url (ENOENT)"],
        ['PORT', expect.any(String)],
        ['URL', expect.any(String)],
      ]),
    );
    expect(JSON.stringify(result.error)).not.toContain(VALUE);
  });
});

describe('*_FILE variables that read nothing', () => {
  const schema = z.object({
    PORT: z.coerce.number().default(3000),
    TOKEN: secret(optional()),
  });

  it('are warned about by name, once', () => {
    const warn = vi.fn();
    const step = withSecretFiles(schema, {
      read: files({}),
      processEnv: {},
      warn,
    });
    const env = {
      TOKEN_FILE: '',
      TOKNE_FILE: '/token',
      PORT_FILE: '/port',
      AWS_SHARED_CREDENTIALS_FILE: '/aws',
      npm_config_userconfig_FILE: '/x',
    };
    step.parse(env);
    step.parse(env);
    expect(warn.mock.calls).toEqual([
      [
        'TOKNE_FILE is set, but TOKNE is not a secret read from a file: ignored (a typo?)',
      ],
      [
        'PORT_FILE is set, but PORT is not a secret read from a file: ignored (a typo?)',
      ],
    ]);
  });

  it('lists only names', () => {
    expect(
      unusedFileVariables({ JWT_SECERT_FILE: VALUE }, ['JWT_SECRET']),
    ).toEqual(['JWT_SECERT_FILE']);
  });
});

describe('secretValue (node dist/migrate)', () => {
  it('reads DATABASE_URL_FILE', () => {
    expect(
      secretValue(
        { DATABASE_URL_FILE: '/u' },
        'DATABASE_URL',
        files({ '/u': `${DB_URL}\n` }),
      ),
    ).toEqual({ value: DB_URL, problems: [] });
  });

  it('falls back to DATABASE_URL', () => {
    expect(
      secretValue({ DATABASE_URL: ` ${DB_URL} ` }, 'DATABASE_URL'),
    ).toEqual({
      value: DB_URL,
      problems: [],
    });
  });

  it('reports both set, and an unreadable file', () => {
    expect(
      secretValue(
        { DATABASE_URL: DB_URL, DATABASE_URL_FILE: '/u' },
        'DATABASE_URL',
      ).problems,
    ).toEqual([
      {
        variable: 'DATABASE_URL_FILE',
        message: 'DATABASE_URL and DATABASE_URL_FILE are both set: keep one',
      },
    ]);
    expect(
      secretValue({ DATABASE_URL_FILE: '/u' }, 'DATABASE_URL', files({})),
    ).toEqual({
      value: undefined,
      problems: [
        { variable: 'DATABASE_URL_FILE', message: "can't read /u (ENOENT)" },
      ],
    });
  });
});

describe('the environment (env.ts)', () => {
  it('declares every secret variable', () => {
    // The features' own (features/env.ts) come and go with them.
    const core = [...SECRET_VARIABLES].filter(
      (name) => !(name in featuresEnv.shape),
    );
    expect(core.sort()).toEqual(
      [
        'ADMIN_PASSWORD',
        'ANTHROPIC_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'CURSOR_KEYS',
        'DATABASE_MAINTENANCE_URL',
        'DATABASE_OWNER_URL',
        'DATABASE_URL',
        'GITHUB_CLIENT_SECRET',
        'GOOGLE_CLIENT_SECRET',
        'IDEMPOTENCY_KEYS',
        'JWT_SECRET',
        'MAIL_API_KEY',
        'METRICS_TOKEN',
        'MFA_ENCRYPTION_KEYS',
        'MICROSOFT_CLIENT_SECRET',
        'OBSERVE_APP_KEY',
        'OBSERVE_APP_SECRET',
        'POSTMARK_WEBHOOK_SECRET',
        'REDIS_PASSWORD',
        'REDIS_URL',
        'SMTP_URL',
        'STORAGE_SIGNING_KEYS',
        'TURNSTILE_SECRET_KEY',
        'WEBHOOKS_ENCRYPTION_KEYS',
      ].sort(),
    );
  });

  it('never puts a rejected secret into its error', () => {
    const shortToken = VALUE.slice(0, 10);
    const result = envSchema.safeParse({
      DATABASE_URL: `mysql://db.internal/${VALUE}`,
      METRICS_TOKEN: shortToken,
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.path.join('.'))).toEqual([
      'DATABASE_URL',
      'METRICS_TOKEN',
    ]);
    const report = `${JSON.stringify(result.error)} ${z.prettifyError(result.error!)}`;
    expect(report).not.toContain(VALUE);
    expect(report).not.toContain(shortToken);
  });
});
