// The wizard's tests: node --test tools/setup/setup.test.mjs. Every test works
// on a copy of the real templates in a temp directory (--root) and writes its
// env file into another (--out): nothing here touches the repository.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyValues,
  formatValue,
  parseEnv,
  templateKeys,
} from './envfile.mjs';
import {
  buildPlan,
  defaultFor,
  QUESTIONS,
  applies,
  writableKeys,
} from './plan.mjs';
import { run } from './setup.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const TEMPLATES = {
  development: 'apps/api/env.development.example',
  production: 'env.example',
};
const FILES = { development: '.env.development', production: '.env' };
const PRODUCTION = [
  '--target',
  'production',
  '--app-domain',
  'api.test.example',
  '--acme-email',
  'ops@example.com',
  '--cloudflare-api-token',
  'cf-test-value',
];

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-test-'));
  temps.push(dir);
  return dir;
}

/** A repository with only the templates (and the notes folder, with `notes`). */
function fixture({ notes = false } = {}) {
  const root = temp();
  for (const template of Object.values(TEMPLATES)) {
    mkdirSync(path.dirname(path.join(root, template)), { recursive: true });
    writeFileSync(
      path.join(root, template),
      readFileSync(path.join(REPO, template), 'utf8'),
    );
  }
  if (notes) {
    const dir = path.join(root, 'apps/api/src/features/notes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'notes.resource.ts'), '');
  }
  return root;
}

/** Runs the wizard with --yes on `root`, writing into `out`. */
async function setup(root, out, args, io = {}) {
  const lines = [];
  const errors = [];
  const code = await run(['--yes', '--root', root, '--out', out, ...args], {
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    isTTY: false,
    ...io,
  });
  return { code, text: lines.join('\n'), errors: errors.join('\n') };
}

const read = (out, target) =>
  readFileSync(path.join(out, FILES[target]), 'utf8');

describe('envfile', () => {
  test('replaces active lines, uncomments examples, keeps comments, order and unknown keys', () => {
    const text = [
      '# A comment',
      'A=1',
      '# B=old',
      'UNKNOWN=keep me',
      '# C: not an example, prose',
      'D=4',
      '',
    ].join('\n');
    const out = applyValues(
      text,
      new Map([
        ['A', 'two'],
        ['B', 'three'],
        ['E', 'new'],
      ]),
    );
    assert.equal(
      out,
      [
        '# A comment',
        'A=two',
        'B=three',
        'UNKNOWN=keep me',
        '# C: not an example, prose',
        'D=4',
        '',
        '# Added by pnpm setup',
        'E=new',
        '',
      ].join('\n'),
    );
  });

  test('a null value empties an active line and leaves a commented one', () => {
    const out = applyValues(
      'A=1\n# B=x\n',
      new Map([
        ['A', null],
        ['B', null],
      ]),
    );
    assert.equal(out, 'A=\n# B=x\n');
  });

  test('values with spaces, # or quotes are quoted and read back the same', () => {
    for (const value of [
      'My API <no-reply@example.com>',
      'a#b',
      "it's",
      'a"b$c',
      'plain',
      '',
    ]) {
      const line = `K=${formatValue(value)}`;
      assert.equal(parseEnv(line).get('K'), value, line);
    }
    assert.equal(formatValue('plain'), 'plain');
    assert.equal(formatValue('a b'), "'a b'");
  });

  test('templateKeys sees active and commented keys, not prose', () => {
    const keys = templateKeys(
      'A=1\n# B=x\n# TENANCY=single: the roles\n# plain words\n',
    );
    assert.deepEqual([...keys].sort(), ['A', 'B']);
  });
});

describe('defaults', () => {
  test('development: changes only what the spec asks (sign-up off), keeps the template', async () => {
    const root = fixture();
    const out = temp();
    const { code, text } = await setup(root, out, ['--target', 'development']);
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'development'));
    assert.equal(env.get('AUTH_SIGN_UP'), 'off');
    assert.equal(env.get('TENANCY'), 'multi');
    assert.equal(env.get('MAIL_TRANSPORT'), 'ses');
    assert.equal(env.get('STORAGE_DRIVER'), 's3');
    assert.ok(env.get('GOTENBERG_URL'));
    const template = readFileSync(
      path.join(root, TEMPLATES.development),
      'utf8',
    );
    assert.equal(
      read(out, 'development'),
      template.replace('AUTH_SIGN_UP=on', 'AUTH_SIGN_UP=off'),
    );
    assert.doesNotMatch(text, /Password/);
  });

  test('production: simple defaults, every secret generated, file mode 600', async () => {
    const root = fixture({ notes: true });
    const out = temp();
    const { code, text } = await setup(root, out, PRODUCTION);
    assert.equal(code, 0, text);
    const file = path.join(out, '.env');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('APP_DOMAIN'), 'api.test.example');
    assert.equal(env.get('ACME_EMAIL'), 'ops@example.com');
    assert.equal(env.get('TENANCY'), 'multi');
    assert.equal(env.get('AUTH_SIGN_UP'), 'off');
    assert.equal(env.get('MAIL_TRANSPORT'), 'log');
    assert.equal(env.get('STORAGE_DRIVER'), 'local');
    assert.equal(env.get('CAPTCHA_MODE'), 'off');
    assert.equal(env.get('PASSKEYS'), 'on');
    assert.equal(env.get('EXCHANGE_RATES_FETCH'), 'off');
    assert.equal(env.get('GOTENBERG_URL'), undefined);
    assert.equal(env.get('METRICS_TOKEN'), '');
    // The notes question defaults to yes in production: the block is gone.
    assert.equal(env.has('EXAMPLE_SENDER_WEBHOOK_SECRET'), false);
  });

  test('secrets have the formats env.example asks for, and only the admin password is printed', async () => {
    const root = fixture();
    const out = temp();
    const { text } = await setup(root, out, [...PRODUCTION, '--metrics']);
    const env = parseEnv(read(out, 'production'));
    for (const key of [
      'POSTGRES_PASSWORD',
      'POSTGRES_APP_PASSWORD',
      'POSTGRES_MAINTENANCE_PASSWORD',
      'POSTGRES_MONITOR_PASSWORD',
      'REDIS_PASSWORD',
      'METRICS_TOKEN',
    ]) {
      assert.match(env.get(key), /^[0-9a-f]{48}$/, key); // openssl rand -hex 24
    }
    for (const key of [
      'IDEMPOTENCY_KEYS',
      'WEBHOOKS_ENCRYPTION_KEYS',
      'MFA_ENCRYPTION_KEYS',
      'STORAGE_SIGNING_KEYS',
      'JWT_SECRET',
    ]) {
      assert.match(env.get(key), /^[A-Za-z0-9+/]{43}=$/, key); // openssl rand -base64 32
    }
    assert.match(env.get('ADMIN_PASSWORD'), /^[A-Za-z0-9+/]{24}$/); // -base64 18
    assert.ok(text.includes(env.get('ADMIN_PASSWORD')));
    for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'METRICS_TOKEN']) {
      assert.ok(!text.includes(env.get(key)), `${key} printed`);
    }
    assert.equal(
      new Set([...env.values()].filter((v) => v.length >= 40)).size,
      [...env.values()].filter((v) => v.length >= 40).length,
      'no value reused',
    );
  });
});

describe('answers', () => {
  test('single tenancy with sign-up sets the roles', async () => {
    const root = fixture();
    const out = temp();
    const { code } = await setup(root, out, [
      ...PRODUCTION,
      '--tenancy',
      'single',
      '--sign-up',
      '--sign-up-roles',
      'editor',
    ]);
    assert.equal(code, 0);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('TENANCY'), 'single');
    assert.equal(env.get('AUTH_SIGN_UP'), 'on');
    assert.equal(env.get('SIGN_UP_ROLES'), 'editor');
  });

  test('sign-up roles are not asked with multi tenancy', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [
      ...PRODUCTION,
      '--sign-up',
      '--sign-up-roles',
      'editor',
    ]);
    assert.equal(parseEnv(read(out, 'production')).get('SIGN_UP_ROLES'), '');
  });

  test('captcha keys are written only when turnstile is chosen', async () => {
    const root = fixture();
    const none = temp();
    await setup(root, none, [...PRODUCTION, '--captcha', 'none']);
    const without = read(none, 'production');
    assert.match(without, /^CAPTCHA_MODE=off$/m);
    assert.match(without, /^TURNSTILE_SITE_KEY=$/m);
    assert.match(without, /^TURNSTILE_SECRET_KEY=$/m);

    const on = temp();
    await setup(root, on, [
      ...PRODUCTION,
      '--captcha',
      'turnstile',
      '--turnstile-site-key',
      '1x-site',
      '--turnstile-secret-key',
      '1x-secret-value',
    ]);
    const env = parseEnv(read(on, 'production'));
    assert.equal(env.get('CAPTCHA_MODE'), 'always');
    assert.equal(env.get('TURNSTILE_SITE_KEY'), '1x-site');
    assert.equal(env.get('TURNSTILE_SECRET_KEY'), '1x-secret-value');
  });

  test('mail, storage, social, passkeys and documents map to their variables', async () => {
    const root = fixture();
    const out = temp();
    const { code, text } = await setup(root, out, [
      ...PRODUCTION,
      '--mail',
      'smtp',
      '--smtp-url',
      'smtp://relay.example.com:587',
      '--mail-from',
      'My API <no-reply@example.com>',
      '--storage',
      's3',
      '--s3-bucket',
      'files',
      '--social',
      'microsoft',
      '--social-client-id',
      'cid',
      '--social-client-secret',
      'csec-value',
      '--microsoft-tenant-id',
      'tid',
      '--web-url',
      'https://app.example.com',
      '--documents',
      '--exchange-rates',
      '--no-passkeys',
    ]);
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('MAIL_TRANSPORT'), 'smtp');
    assert.equal(env.get('SMTP_URL'), 'smtp://relay.example.com:587');
    assert.equal(env.get('MAIL_FROM'), 'My API <no-reply@example.com>');
    assert.equal(env.get('STORAGE_DRIVER'), 's3');
    assert.equal(env.get('S3_BUCKET'), 'files');
    assert.equal(env.get('AWS_REGION'), 'us-east-1');
    assert.equal(env.get('MICROSOFT_CLIENT_ID'), 'cid');
    assert.equal(env.get('MICROSOFT_CLIENT_SECRET'), 'csec-value');
    assert.equal(env.get('MICROSOFT_TENANT_ID'), 'tid');
    assert.equal(env.get('GOOGLE_CLIENT_ID'), undefined);
    assert.equal(env.get('WEB_URL'), 'https://app.example.com');
    assert.equal(env.get('CORS_ORIGINS'), 'https://app.example.com');
    assert.equal(env.get('GOTENBERG_URL'), 'http://gotenberg:3000');
    assert.equal(env.get('EXCHANGE_RATES_FETCH'), 'on');
    assert.equal(env.get('PASSKEYS'), 'off');
    assert.equal(env.get('PASSKEY_RP_ID'), '');
  });

  test('passkeys default their relying party id from the web URL host', () => {
    const q = QUESTIONS.find((x) => x.id === 'passkeyRpId');
    assert.equal(
      defaultFor(
        q,
        { webUrl: 'https://app.example.com/x' },
        { existing: null },
      ),
      'app.example.com',
    );
  });

  test('a flag with a wrong value is an error naming the flag', async () => {
    const root = fixture();
    await assert.rejects(
      setup(root, temp(), [...PRODUCTION, '--mail', 'carrier-pigeon']),
      /--mail: one of log, smtp/,
    );
  });
});

describe('re-runs', () => {
  test('keeps the existing secrets and values, writes a .bak, rotates with --rotate', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [...PRODUCTION, '--tenancy', 'single']);
    const first = read(out, 'production');
    const before = parseEnv(first);

    const second = await setup(root, out, ['--target', 'production']);
    assert.equal(second.code, 0, second.text);
    assert.equal(read(out, 'production'), first, 'unchanged');
    assert.equal(parseEnv(read(out, 'production')).get('TENANCY'), 'single');
    assert.ok(existsSync(path.join(out, '.env.bak')));
    assert.doesNotMatch(second.text, /Password \(shown once/);

    const rotated = await setup(root, out, [
      '--target',
      'production',
      '--rotate',
    ]);
    assert.equal(rotated.code, 0, rotated.text);
    const after = parseEnv(read(out, 'production'));
    assert.notEqual(after.get('JWT_SECRET'), before.get('JWT_SECRET'));
    assert.notEqual(after.get('REDIS_PASSWORD'), before.get('REDIS_PASSWORD'));
    // Keys are put in front, newest first; the old one stays.
    const keys = after.get('MFA_ENCRYPTION_KEYS').split(',');
    assert.equal(keys.length, 2);
    assert.equal(keys[1], before.get('MFA_ENCRYPTION_KEYS'));
    // The administrator's password is the first start's business.
    assert.equal(after.get('ADMIN_PASSWORD'), before.get('ADMIN_PASSWORD'));
    assert.match(rotated.errors, /Rotated database/);
    assert.equal(after.get('APP_DOMAIN'), 'api.test.example');
  });

  test('changing TENANCY or the passkey relying party id warns', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [
      ...PRODUCTION,
      '--tenancy',
      'single',
      '--web-url',
      'https://app.example.com',
    ]);
    const { errors } = await setup(root, out, [
      '--target',
      'production',
      '--tenancy',
      'multi',
      '--passkey-rp-id',
      'other.example.com',
    ]);
    assert.match(errors, /WARNING: TENANCY changes from single to multi/);
    assert.match(errors, /WARNING: PASSKEY_RP_ID changes/);
  });

  test('keeps the lines the template does not know', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, PRODUCTION);
    const file = path.join(out, '.env');
    writeFileSync(file, `${readFileSync(file, 'utf8')}MY_OWN=1\n`);
    await setup(root, out, ['--target', 'production', '--no-passkeys']);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('MY_OWN'), '1');
    assert.equal(env.get('PASSKEYS'), 'off');
  });
});

describe('modes', () => {
  test('--dry-run prints the masked plan and writes nothing', async () => {
    const root = fixture();
    const out = temp();
    const { code, text } = await setup(root, out, [...PRODUCTION, '--dry-run']);
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(out, '.env')), false);
    assert.match(text, /Dry run: nothing written/);
    assert.match(text, /JWT_SECRET=\*{8}/);
    assert.doesNotMatch(text, /cf-test-value/);
  });

  test('--yes without a required value is an error naming the flags', async () => {
    const root = fixture();
    const out = temp();
    await assert.rejects(
      setup(root, out, ['--target', 'production']),
      /--app-domain, --acme-email, --cloudflare-api-token/,
    );
    assert.equal(existsSync(path.join(out, '.env')), false);
  });

  test('without a terminal and without --yes it exits 1 with a message', async () => {
    const errors = [];
    const code = await run(['--root', fixture(), '--out', temp()], {
      isTTY: false,
      err: (l) => errors.push(l),
    });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /needs a terminal/);
  });

  test('interactive: asks in order, takes the defaults, confirms', async () => {
    const root = fixture();
    const out = temp();
    const asked = [];
    const code = await run(
      ['--root', root, '--out', out, '--target', 'development'],
      {
        isTTY: true,
        out: () => {},
        ask: async (line) => {
          asked.push(line);
          return line.startsWith('One organization') ? 'single' : '';
        },
      },
    );
    assert.equal(code, 0);
    assert.match(
      asked[0],
      /^One organization or many\? \(multi\/single\) \[multi\]/,
    );
    assert.match(asked.at(-1), /^\nWrite /);
    assert.equal(parseEnv(read(out, 'development')).get('TENANCY'), 'single');
  });
});

describe('the example feature', () => {
  test('removing it runs feature:remove and drops its env block', async () => {
    const root = fixture({ notes: true });
    const out = temp();
    const { code, text } = await setup(root, out, [
      ...PRODUCTION,
      '--remove-notes',
    ]);
    assert.equal(code, 0, text);
    assert.equal(
      existsSync(path.join(root, 'apps/api/src/features/notes')),
      false,
    );
    assert.equal(
      parseEnv(readFileSync(path.join(root, 'env.example'), 'utf8')).has(
        'EXAMPLE_SENDER_WEBHOOK_SECRET',
      ),
      false,
    );
    assert.equal(
      parseEnv(read(out, 'production')).has('EXAMPLE_SENDER_WEBHOOK_SECRET'),
      false,
    );
    assert.match(text, /pnpm db:generate/);
  });

  test('keeping it generates its webhook secret; development keeps it by default', async () => {
    const root = fixture({ notes: true });
    const out = temp();
    await setup(root, out, [...PRODUCTION, '--no-remove-notes']);
    assert.match(
      parseEnv(read(out, 'production')).get('EXAMPLE_SENDER_WEBHOOK_SECRET'),
      /^whsec_[A-Za-z0-9+/]{43}=$/,
    );
    const calls = [];
    const dev = temp();
    await setup(root, dev, ['--target', 'development'], {
      runRemove: (r) => calls.push(r) && 0,
    });
    assert.deepEqual(calls, []);
    assert.ok(existsSync(path.join(root, 'apps/api/src/features/notes')));
  });

  test('the runner gets the root when notes is removed; absent notes is not asked', async () => {
    const root = fixture({ notes: true });
    const calls = [];
    await setup(root, temp(), [...PRODUCTION], {
      runRemove: (r) => calls.push(r) && 0,
    });
    assert.deepEqual(calls, [root]);

    const bare = fixture();
    const ctx = {
      target: 'production',
      keys: templateKeys(readFileSync(path.join(bare, 'env.example'), 'utf8')),
      hasNotes: false,
    };
    assert.equal(
      applies(
        QUESTIONS.find((q) => q.id === 'removeNotes'),
        {},
        ctx,
      ),
      false,
    );
  });
});

describe('templates and wizard do not drift', () => {
  for (const target of ['development', 'production']) {
    test(`${target}: every variable the wizard can write is in ${TEMPLATES[target]}`, () => {
      const text = readFileSync(path.join(REPO, TEMPLATES[target]), 'utf8');
      const ctx = {
        target,
        tpl: parseEnv(text),
        keys: templateKeys(text),
        existing: null,
        current: parseEnv(text),
        hasNotes: true,
      };
      const known = new Set(templateKeys(text));
      for (const key of writableKeys(ctx)) {
        assert.ok(known.has(key), `${key} is not in ${TEMPLATES[target]}`);
      }
      // And the plan of the fullest answers writes nothing else.
      const answers = {};
      for (const q of QUESTIONS) {
        if (applies(q, answers, ctx))
          answers[q.id] = defaultFor(q, answers, ctx) ?? 'x';
      }
      const plan = buildPlan({ answers, ctx });
      for (const key of plan.values.keys()) {
        assert.ok(known.has(key), `${key} is not in ${TEMPLATES[target]}`);
      }
    });
  }

  test('production asks every question its template can answer', () => {
    // A production variable renamed in env.example silently drops a question
    // otherwise: the questions of the production target must all apply.
    const text = readFileSync(path.join(REPO, TEMPLATES.production), 'utf8');
    const ctx = {
      target: 'production',
      keys: templateKeys(text),
      hasNotes: true,
    };
    const sets = [
      {
        tenancy: 'single',
        signUp: true,
        mail: 'smtp',
        storage: 's3',
        captcha: 'turnstile',
        passkeys: true,
        social: 'microsoft',
      },
      { mail: 'resend', social: 'google' },
    ];
    for (const q of QUESTIONS) {
      assert.ok(
        sets.some((answers) => applies(q, answers, ctx)),
        `${q.id} is not asked in production`,
      );
    }
  });
});
