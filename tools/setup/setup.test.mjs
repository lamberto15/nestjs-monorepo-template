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
  duplicateKeys,
  formatValue,
  mergeTemplate,
  missingKeys,
  parseEnv,
  templateKeys,
  unknownKeys,
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

/** Sets these values in the production file of `out`, as its owner would. */
function edit(out, values) {
  const file = path.join(out, FILES.production);
  writeFileSync(file, applyValues(readFileSync(file, 'utf8'), new Map(values)));
}

/** A production re-run with no flags, which must succeed: its variables. */
async function rerun(root, out) {
  const { code, text, errors } = await setup(root, out, [
    '--target',
    'production',
  ]);
  assert.equal(code, 0, `${text}\n${errors}`);
  return parseEnv(read(out, 'production'));
}

/**
 * The template as an older one: without the given variables, each with the
 * comment right above it and the blank line that opened its paragraph.
 */
function olderTemplate(text, keys) {
  const lines = text.split('\n');
  const drop = new Set();
  for (const key of keys) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    assert.ok(at >= 0, `${key} is not an active variable of the template`);
    let start = at;
    while (
      start > 0 &&
      lines[start - 1].startsWith('#') &&
      !/^#\s?[A-Z][A-Z0-9_]*=(?:|\S*[^\s.,;:)])$/.test(lines[start - 1]) &&
      !lines[start - 1].startsWith('# feature:')
    )
      start--;
    if (start > 0 && lines[start - 1] === '') start--;
    for (let i = start; i <= at; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

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

  test('a sentence that ends on KEY=value. is prose, not a commented example', () => {
    const keys = templateKeys(
      '# (only the load test, APP_ENV=loadtest.)\n# APP_ENV=loadtest.\n# C=\n',
    );
    assert.deepEqual([...keys], ['C']);
  });
});

describe('merging the template', () => {
  const template = [
    '# Head',
    'A=1',
    '',
    '# About B',
    '# and more',
    'B=2',
    'C=3',
    '',
    '# About D',
    'D=4',
    '# E=example',
    '',
  ].join('\n');

  test('adds a missing variable after the one before it in the template, with its comment and paragraph', () => {
    const { text, added } = mergeTemplate(
      '# Head\nA=x\n\nD=custom\n',
      template,
    );
    assert.equal(
      text,
      [
        '# Head',
        'A=x',
        '',
        '# About B',
        '# and more',
        'B=2',
        'C=3',
        '',
        'D=custom',
        '',
      ].join('\n'),
    );
    assert.deepEqual(added, [
      { key: 'B', value: '2' },
      { key: 'C', value: '3' },
    ]);
  });

  test('changes nothing when the file has every variable; a commented example counts as named', () => {
    const file = 'A=x\nB=y\nC=z\n# D=chosen\n';
    assert.deepEqual(mergeTemplate(file, template), { text: file, added: [] });
  });

  test('a variable with no neighbour in the file goes to the end, under a heading', () => {
    const { text } = mergeTemplate('MINE=1\n', 'A=1\nB=2\n');
    assert.equal(
      text,
      'MINE=1\n\n# New in the template (added by pnpm setup)\nA=1\nB=2\n',
    );
  });

  test('the anchor keeps the note under it: the new text goes after the note', () => {
    const tpl = 'A=1\n# a note on A\n\n# about B\nB=2\n';
    const { text } = mergeTemplate('A=1\n# a note on A\n', tpl);
    assert.equal(text, 'A=1\n# a note on A\n\n# about B\nB=2\n');
  });

  test('leaves out a feature block the file no longer has', () => {
    const tpl = 'A=1\n# feature:notes begin\nN=1\n# feature:notes end\nB=2\n';
    const without = mergeTemplate('A=1\n', tpl);
    assert.deepEqual(
      without.added.map((a) => a.key),
      ['B'],
    );
    const withBlock = mergeTemplate(
      'A=1\n# feature:notes begin\n# feature:notes end\n',
      tpl,
    );
    assert.deepEqual(
      withBlock.added.map((a) => a.key),
      ['N', 'B'],
    );
  });

  test('missing, unknown and repeated names', () => {
    assert.deepEqual(
      missingKeys('A=1\nB=2\n# C=3\n', 'A=1\n').map((m) => m.key),
      ['B'],
    );
    assert.deepEqual(unknownKeys('A=1\n# C=3\n', 'A=1\nC=x\nZ=9\n'), ['Z']);
    assert.deepEqual(duplicateKeys('A=1\nB=2\nA=3\n'), ['A']);
  });

  test('env.example: every variable removed from an older copy comes back where it was', () => {
    const text = readFileSync(path.join(REPO, 'env.example'), 'utf8');
    const keys = missingKeys(text, '').map((m) => m.key);
    // The first one has nothing before it to sit after: it goes to the end.
    for (const key of keys.slice(1)) {
      assert.equal(
        mergeTemplate(olderTemplate(text, [key]), text).text,
        text,
        key,
      );
    }
    // Many at once: every third, and all after the 40th.
    for (const pick of [keys.filter((_, i) => i % 3 === 1), keys.slice(40)]) {
      const merged = mergeTemplate(olderTemplate(text, pick), text);
      assert.equal(merged.text, text);
      assert.deepEqual(
        merged.added.map((a) => a.key),
        pick,
      );
    }
  });
});

describe('defaults', () => {
  test('development: changes only what the spec asks (sign-up off, the data key made), keeps the template', async () => {
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
    // The encrypted columns' key (SSO's client secrets): generated, as in production.
    const key = env.get('DATA_ENCRYPTION_KEYS');
    const indexKey = env.get('BLIND_INDEX_KEYS');
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.equal(Buffer.from(indexKey, 'base64').length, 32);
    assert.notEqual(key, indexKey);
    assert.equal(
      read(out, 'development'),
      template
        .replace('AUTH_SIGN_UP=on', 'AUTH_SIGN_UP=off')
        .replace('DATA_ENCRYPTION_KEYS=\n', `DATA_ENCRYPTION_KEYS=${key}\n`)
        .replace('BLIND_INDEX_KEYS=\n', `BLIND_INDEX_KEYS=${indexKey}\n`),
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
      'CURSOR_KEYS',
      'DATA_ENCRYPTION_KEYS',
      'BLIND_INDEX_KEYS',
      'JWT_SECRET',
    ]) {
      assert.match(env.get(key), /^[A-Za-z0-9+/]{43}=$/, key); // openssl rand -base64 32
    }
    assert.match(env.get('ADMIN_PASSWORD'), /^[A-Za-z0-9+/]{24}$/); // -base64 18
    // Never printed: it's in the file only.
    assert.ok(!text.includes(env.get('ADMIN_PASSWORD')));
    assert.match(text, /ADMIN_PASSWORD in /);
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
    assert.doesNotMatch(second.text, /First administrator/);

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

describe('deployment switches', () => {
  test('production defaults: idempotency required, services on, MFA and API clients on, impersonation off', async () => {
    const root = fixture();
    const out = temp();
    const { code, text } = await setup(root, out, PRODUCTION);
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('IDEMPOTENCY'), 'required');
    for (const key of ['WEBHOOKS', 'REPORTS', 'USAGE', 'REALTIME']) {
      assert.equal(env.get(key), 'on', key);
    }
    assert.equal(env.get('AUTH_MFA'), 'on');
    assert.equal(env.get('API_CLIENTS'), 'on');
    assert.equal(env.get('IMPERSONATION'), 'off');
  });

  test('development keeps its template: impersonation on, services commented, the rest not asked', async () => {
    const root = fixture();
    const out = temp();
    const { code, text } = await setup(root, out, ['--target', 'development']);
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'development'));
    assert.equal(env.get('IMPERSONATION'), 'on');
    for (const key of ['WEBHOOKS', 'REPORTS', 'USAGE', 'REALTIME']) {
      assert.equal(env.has(key), false, key);
    }
    for (const key of ['IDEMPOTENCY', 'AUTH_MFA', 'API_CLIENTS']) {
      assert.equal(env.has(key), false, key);
    }
  });

  test('flags set every switch, in both targets', async () => {
    const flags = [
      '--idempotency',
      'optional',
      '--no-webhooks',
      '--no-reports',
      '--no-usage',
      '--no-realtime',
      '--no-auth-mfa',
      '--no-api-clients',
      '--impersonation',
    ];
    const root = fixture();
    const out = temp();
    const production = await setup(root, out, [...PRODUCTION, ...flags]);
    assert.equal(production.code, 0, production.text);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('IDEMPOTENCY'), 'optional');
    for (const key of ['WEBHOOKS', 'REPORTS', 'USAGE', 'REALTIME']) {
      assert.equal(env.get(key), 'off', key);
    }
    assert.equal(env.get('AUTH_MFA'), 'off');
    assert.equal(env.get('API_CLIENTS'), 'off');
    assert.equal(env.get('IMPERSONATION'), 'on');

    const devOut = temp();
    const development = await setup(root, devOut, [
      '--target',
      'development',
      '--no-webhooks',
      '--no-impersonation',
    ]);
    assert.equal(development.code, 0, development.text);
    const dev = parseEnv(read(devOut, 'development'));
    assert.equal(dev.get('WEBHOOKS'), 'off');
    assert.equal(dev.get('IMPERSONATION'), 'off');
    assert.equal(dev.has('REPORTS'), false);
  });

  test('a wrong idempotency value is an error naming the flag', async () => {
    await assert.rejects(
      setup(fixture(), temp(), [...PRODUCTION, '--idempotency', 'maybe']),
      /--idempotency: one of required, optional/,
    );
  });

  test('a re-run reads the existing values and keeps them', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [
      ...PRODUCTION,
      '--idempotency',
      'optional',
      '--no-realtime',
      '--no-api-clients',
      '--impersonation',
    ]);
    const first = read(out, 'production');
    const again = await setup(root, out, ['--target', 'production']);
    assert.equal(again.code, 0, again.text);
    assert.equal(read(out, 'production'), first, 'unchanged');
    const env = parseEnv(first);
    assert.equal(env.get('IDEMPOTENCY'), 'optional');
    assert.equal(env.get('REALTIME'), 'off');
    assert.equal(env.get('API_CLIENTS'), 'off');
    assert.equal(env.get('IMPERSONATION'), 'on');
  });

  test('the writable keys cover every switch the templates name', () => {
    for (const [target, names] of [
      [
        'production',
        [
          'IDEMPOTENCY',
          'WEBHOOKS',
          'REPORTS',
          'USAGE',
          'REALTIME',
          'AUTH_MFA',
          'API_CLIENTS',
          'IMPERSONATION',
        ],
      ],
      [
        'development',
        ['WEBHOOKS', 'REPORTS', 'USAGE', 'REALTIME', 'IMPERSONATION'],
      ],
    ]) {
      const text = readFileSync(path.join(REPO, TEMPLATES[target]), 'utf8');
      const ctx = {
        target,
        tpl: parseEnv(text),
        keys: templateKeys(text),
        existing: null,
        current: parseEnv(text),
        hasNotes: false,
      };
      const writable = writableKeys(ctx);
      for (const name of names) {
        assert.ok(writable.has(name), `${target}: ${name} is not writable`);
      }
    }
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
        observe: true,
        otelEndpoint: 'https://otel.example.com',
        push: true,
        sms: true,
      },
      { tenancy: 'multi', signUp: true, mail: 'resend', social: 'google' },
    ];
    for (const q of QUESTIONS) {
      assert.ok(
        sets.some((answers) => applies(q, answers, ctx)),
        `${q.id} is not asked in production`,
      );
    }
  });
});

describe('a re-run merges what the template gained', () => {
  /** A fixture whose env.example is an older one, without `gone`; its first run done. */
  async function aged(gone, args = PRODUCTION) {
    const root = fixture();
    const template = path.join(root, TEMPLATES.production);
    const current = readFileSync(template, 'utf8');
    writeFileSync(template, olderTemplate(current, gone));
    const out = temp();
    const first = await setup(root, out, args);
    assert.equal(first.code, 0, first.text);
    for (const key of gone) {
      assert.equal(parseEnv(read(out, 'production')).has(key), false, key);
    }
    writeFileSync(template, current);
    return { root, out, current };
  }

  const GONE = [
    'WEBHOOKS',
    'REPORTS',
    'SMS_PROVIDER',
    'TWILIO_FROM',
    'PUSH_PROVIDER',
    'WEB_PUSH_SUBJECT',
    'OBSERVE_APP_KEY',
    'USAGE_RETENTION_DAYS',
    'DATA_ENCRYPTION_KEYS_FILE',
    'POSTGRES_REPORTING_PASSWORD',
  ];

  test('adds each missing variable with the template default and shows it as + NAME=default', async () => {
    const { root, out, current } = await aged(GONE);
    const before = parseEnv(read(out, 'production'));
    const { code, text } = await setup(root, out, ['--target', 'production']);
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'production'));
    const template = parseEnv(current);
    for (const key of GONE) {
      assert.ok(env.has(key), `${key} was not added`);
      if (key === 'POSTGRES_REPORTING_PASSWORD') continue;
      assert.equal(env.get(key), template.get(key), key);
      assert.match(
        text,
        new RegExp(`^  \\+ ${key}=${template.get(key)}$`, 'm'),
      );
    }
    assert.match(
      text,
      /New in env\.example since this file was written \(10\)/,
    );
    // The reporting role's password is a secret like the others: made, hidden.
    assert.match(env.get('POSTGRES_REPORTING_PASSWORD'), /^[0-9a-f]{48}$/);
    assert.match(text, /^  \+ POSTGRES_REPORTING_PASSWORD=\*{8}$/m);
    assert.ok(!text.includes(env.get('POSTGRES_REPORTING_PASSWORD')));
    // What the file had is untouched.
    for (const [key, value] of before) assert.equal(env.get(key), value, key);
    // And the file reads like a fresh one: the same names, in the same order.
    const fresh = temp();
    await setup(root, fresh, PRODUCTION);
    assert.deepEqual(
      [...env.keys()],
      [...parseEnv(read(fresh, 'production')).keys()],
    );
  });

  test('the second re-run has nothing left to add', async () => {
    const { root, out } = await aged(GONE);
    await setup(root, out, ['--target', 'production']);
    const merged = read(out, 'production');
    const again = await setup(root, out, ['--target', 'production']);
    assert.equal(read(out, 'production'), merged);
    assert.doesNotMatch(again.text, /New in env\.example/);
  });

  test('--dry-run lists them and writes nothing', async () => {
    const { root, out } = await aged(GONE);
    const before = read(out, 'production');
    const { text } = await setup(root, out, [
      '--target',
      'production',
      '--dry-run',
    ]);
    assert.match(text, /^  \+ WEBHOOKS=on$/m);
    assert.equal(read(out, 'production'), before);
  });

  test('a variable the owner commented out is left alone, and the .bak keeps the old file', async () => {
    const { root, out } = await aged(['REPORTS', 'USAGE_RETENTION_DAYS']);
    const file = path.join(out, '.env');
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}# USAGE_RETENTION_DAYS=30\n`,
    );
    const old = readFileSync(file, 'utf8');
    await setup(root, out, ['--target', 'production']);
    const text = read(out, 'production');
    assert.match(text, /^# USAGE_RETENTION_DAYS=30$/m);
    assert.doesNotMatch(text, /^USAGE_RETENTION_DAYS=/m);
    assert.match(text, /^REPORTS=on$/m);
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), old);
  });

  test('development merges its own template too', async () => {
    const root = fixture();
    const template = path.join(root, TEMPLATES.development);
    const current = readFileSync(template, 'utf8');
    writeFileSync(
      template,
      olderTemplate(current, ['LOG_LEVEL', 'SENTRY_DSN']),
    );
    const out = temp();
    await setup(root, out, ['--target', 'development']);
    writeFileSync(template, current);
    const { text } = await setup(root, out, ['--target', 'development']);
    assert.match(text, /^  \+ LOG_LEVEL=debug$/m);
    assert.match(text, /^  \+ SENTRY_DSN=$/m);
    assert.equal(parseEnv(read(out, 'development')).get('LOG_LEVEL'), 'debug');
  });

  test('the example feature removed in the same run is not brought back', async () => {
    const root = fixture({ notes: true });
    const out = temp();
    await setup(root, out, [...PRODUCTION, '--no-remove-notes'], {
      runRemove: () => 0,
    });
    const { text } = await setup(
      root,
      out,
      ['--target', 'production', '--remove-notes'],
      {
        runRemove: () => 0,
      },
    );
    assert.doesNotMatch(text, /EXAMPLE_SENDER_WEBHOOK_SECRET/);
    assert.equal(
      parseEnv(read(out, 'production')).has('NOTE_PUBLISH_DELAY'),
      false,
    );
  });

  test('a secret kept in a file is not made again in the variable', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, PRODUCTION);
    const file = path.join(out, '.env');
    writeFileSync(
      file,
      readFileSync(file, 'utf8')
        .replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=')
        .replace(/^JWT_SECRET_FILE=.*$/m, 'JWT_SECRET_FILE=/run/secrets/jwt'),
    );
    await setup(root, out, ['--target', 'production', '--rotate']);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('JWT_SECRET'), '');
    assert.equal(env.get('JWT_SECRET_FILE'), '/run/secrets/jwt');
  });
});

describe('questions for observability, the AI key, push and SMS', () => {
  const KEYS = { publicKey: 'pub-key', privateKey: 'priv-key' };
  const vapid = () => KEYS;

  test('all off by default: nothing is set, no key pair is made', async () => {
    const root = fixture();
    const out = temp();
    const { code, text, errors } = await setup(root, out, PRODUCTION, {
      vapid,
    });
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'production'));
    for (const key of [
      'OBSERVE_APP_KEY',
      'OBSERVE_APP_SECRET',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'SENTRY_DSN',
      'ANTHROPIC_API_KEY',
      'WEB_PUSH_VAPID_PUBLIC_KEY',
      'TWILIO_ACCOUNT_SID',
    ]) {
      assert.equal(env.get(key), '', key);
    }
    assert.equal(env.get('PUSH_PROVIDER'), 'off');
    assert.equal(env.get('SMS_PROVIDER'), 'off');
    assert.doesNotMatch(errors, /VAPID|SMS_ALLOWED/);
  });

  test('flags set them; secrets are masked, nothing is printed', async () => {
    const root = fixture();
    const out = temp();
    const { code, text } = await setup(
      root,
      out,
      [
        ...PRODUCTION,
        '--admin-email',
        'ops@acme.io',
        '--observe',
        '--observe-app-key',
        'ok-123',
        '--observe-app-secret',
        'os-secret-value',
        '--otel-endpoint',
        'https://otel.acme.test:4318',
        '--otel-headers',
        'x-honeycomb-team=hc-secret',
        '--sentry-dsn',
        'https://pub@o1.ingest.sentry.io/2',
        '--anthropic-api-key',
        'sk-ant-test',
        '--push',
        '--sms',
        '--twilio-account-sid',
        'AC123',
        '--twilio-auth-token',
        'tw-token-value',
        '--twilio-from',
        '+15551234567',
        '--sms-allowed-prefixes',
        '+1, +44',
      ],
      { vapid },
    );
    assert.equal(code, 0, text);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('OBSERVE_APP_KEY'), 'ok-123');
    assert.equal(env.get('OBSERVE_APP_SECRET'), 'os-secret-value');
    assert.equal(
      env.get('OTEL_EXPORTER_OTLP_ENDPOINT'),
      'https://otel.acme.test:4318',
    );
    assert.equal(
      env.get('OTEL_EXPORTER_OTLP_HEADERS'),
      'x-honeycomb-team=hc-secret',
    );
    assert.equal(env.get('SENTRY_DSN'), 'https://pub@o1.ingest.sentry.io/2');
    assert.equal(env.get('ANTHROPIC_API_KEY'), 'sk-ant-test');
    assert.equal(env.get('PUSH_PROVIDER'), 'web-push');
    assert.equal(env.get('WEB_PUSH_SUBJECT'), 'mailto:ops@acme.io');
    assert.equal(env.get('SMS_PROVIDER'), 'twilio');
    assert.equal(env.get('TWILIO_ACCOUNT_SID'), 'AC123');
    assert.equal(env.get('TWILIO_AUTH_TOKEN'), 'tw-token-value');
    assert.equal(env.get('TWILIO_FROM'), '+15551234567');
    assert.equal(env.get('SMS_ALLOWED_PREFIXES'), '+1, +44');
    for (const secret of [
      'os-secret-value',
      'hc-secret',
      'sk-ant-test',
      'tw-token-value',
      'priv-key',
      'pub@o1',
    ]) {
      assert.ok(!text.includes(secret), `${secret} printed`);
    }
  });

  test('push: the VAPID pair is made once and kept, even by --rotate', async () => {
    const root = fixture();
    const out = temp();
    const args = [
      ...PRODUCTION,
      '--push',
      '--web-push-subject',
      'https://acme.test',
    ];
    const first = await setup(root, out, args, { vapid });
    assert.match(
      first.text,
      /Generated \d+ secrets: .*WEB_PUSH_VAPID_PRIVATE_KEY/,
    );
    let env = parseEnv(read(out, 'production'));
    assert.equal(env.get('WEB_PUSH_VAPID_PUBLIC_KEY'), 'pub-key');
    assert.equal(env.get('WEB_PUSH_VAPID_PRIVATE_KEY'), 'priv-key');
    const other = () => ({ publicKey: 'other-pub', privateKey: 'other-priv' });
    await setup(root, out, ['--target', 'production', '--rotate'], {
      vapid: other,
    });
    env = parseEnv(read(out, 'production'));
    assert.equal(env.get('WEB_PUSH_VAPID_PUBLIC_KEY'), 'pub-key');
    assert.equal(env.get('WEB_PUSH_VAPID_PRIVATE_KEY'), 'priv-key');
    // Emptied on purpose: a new pair.
    writeFileSync(
      path.join(out, '.env'),
      read(out, 'production').replace(
        /^WEB_PUSH_VAPID_PRIVATE_KEY=.*$/m,
        'WEB_PUSH_VAPID_PRIVATE_KEY=',
      ),
    );
    await setup(root, out, ['--target', 'production'], { vapid: other });
    assert.equal(
      parseEnv(read(out, 'production')).get('WEB_PUSH_VAPID_PRIVATE_KEY'),
      'other-priv',
    );
  });

  test('push: without the web-push package the keys are left out, with the way to make them', async () => {
    const root = fixture();
    const out = temp();
    const { code, errors } = await setup(
      root,
      out,
      [...PRODUCTION, '--push', '--web-push-subject', 'https://acme.test'],
      { vapid: () => null },
    );
    assert.equal(code, 0);
    assert.match(
      errors,
      /WARNING: The web-push package is not installed.*npx web-push generate-vapid-keys/,
    );
    assert.equal(
      parseEnv(read(out, 'production')).get('WEB_PUSH_VAPID_PRIVATE_KEY'),
      '',
    );
  });

  test('push: web-push joins the providers the file names, and --no-push takes only it away', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, PRODUCTION);
    const file = path.join(out, '.env');
    writeFileSync(
      file,
      read(out, 'production').replace(
        /^PUSH_PROVIDER=.*$/m,
        'PUSH_PROVIDER=apns,fcm',
      ),
    );
    await setup(
      root,
      out,
      [
        '--target',
        'production',
        '--push',
        '--web-push-subject',
        'https://acme.test',
      ],
      { vapid },
    );
    assert.equal(
      parseEnv(read(out, 'production')).get('PUSH_PROVIDER'),
      'apns,fcm,web-push',
    );
    await setup(root, out, ['--target', 'production', '--no-push']);
    assert.equal(
      parseEnv(read(out, 'production')).get('PUSH_PROVIDER'),
      'apns,fcm',
    );
    writeFileSync(
      file,
      read(out, 'production').replace(
        /^PUSH_PROVIDER=.*$/m,
        'PUSH_PROVIDER=web-push',
      ),
    );
    await setup(root, out, ['--target', 'production', '--no-push']);
    assert.equal(parseEnv(read(out, 'production')).get('PUSH_PROVIDER'), 'off');
  });

  test('push: a placeholder administrator address is no default contact', async () => {
    const root = fixture();
    await assert.rejects(
      setup(root, temp(), [...PRODUCTION, '--push'], { vapid }),
      /--web-push-subject/,
    );
    await assert.rejects(
      setup(
        root,
        temp(),
        [...PRODUCTION, '--push', '--web-push-subject', 'ops@acme.io'],
        { vapid },
      ),
      /mailto:ops@example.com or an https URL/,
    );
  });

  test('sms: the credentials are needed; an empty prefix list is warned about; off keeps them', async () => {
    const root = fixture();
    await assert.rejects(
      setup(root, temp(), [...PRODUCTION, '--sms']),
      /--twilio-account-sid, --twilio-auth-token, --twilio-from/,
    );
    await assert.rejects(
      setup(root, temp(), [
        ...PRODUCTION,
        '--sms',
        '--twilio-account-sid',
        'AC1',
        '--twilio-auth-token',
        't',
        '--twilio-from',
        'nope',
      ]),
      /--twilio-from: a number like/,
    );
    const out = temp();
    const on = [
      ...PRODUCTION,
      '--sms',
      '--twilio-account-sid',
      'AC1',
      '--twilio-auth-token',
      'token-value',
      '--twilio-from',
      'MG0123456789abcdef0123456789abcdef',
    ];
    const { errors } = await setup(root, out, on);
    assert.match(errors, /WARNING: SMS_ALLOWED_PREFIXES is empty/);
    await setup(root, out, ['--target', 'production', '--no-sms']);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('SMS_PROVIDER'), 'off');
    assert.equal(env.get('TWILIO_AUTH_TOKEN'), 'token-value');
    await assert.rejects(
      setup(root, temp(), [...on, '--sms-allowed-prefixes', '1,44']),
      /--sms-allowed-prefixes: prefixes like \+1,\+44/,
    );
  });

  test('observe off empties the keys of an earlier run; the questions keep the file as their default', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [
      ...PRODUCTION,
      '--observe',
      '--observe-app-key',
      'k1',
      '--observe-app-secret',
      's1-value',
    ]);
    await setup(root, out, ['--target', 'production']);
    assert.equal(
      parseEnv(read(out, 'production')).get('OBSERVE_APP_KEY'),
      'k1',
    );
    await setup(root, out, ['--target', 'production', '--no-observe']);
    const env = parseEnv(read(out, 'production'));
    assert.equal(env.get('OBSERVE_APP_KEY'), '');
    assert.equal(env.get('OBSERVE_APP_SECRET'), '');
  });

  test('a credential kept in a file is not asked for again, and no second source is written', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, PRODUCTION);
    // The documented Docker or Swarm secrets setup: the secrets are in files.
    edit(out, [
      ['OBSERVE_APP_KEY', 'k1'],
      ['OBSERVE_APP_SECRET_FILE', '/run/secrets/observe'],
      ['SMS_PROVIDER', 'twilio'],
      ['TWILIO_ACCOUNT_SID', 'AC1'],
      ['TWILIO_AUTH_TOKEN_FILE', '/run/secrets/twilio'],
      ['TWILIO_FROM', '+15551234567'],
    ]);
    // Without the fix this re-run threw: "A value is needed for
    // --observe-app-secret, --twilio-auth-token".
    const env = await rerun(root, out);
    assert.equal(env.get('OBSERVE_APP_KEY'), 'k1');
    assert.equal(env.get('OBSERVE_APP_SECRET'), '');
    assert.equal(env.get('OBSERVE_APP_SECRET_FILE'), '/run/secrets/observe');
    assert.equal(env.get('SMS_PROVIDER'), 'twilio');
    assert.equal(env.get('TWILIO_AUTH_TOKEN'), '');
    assert.equal(env.get('TWILIO_AUTH_TOKEN_FILE'), '/run/secrets/twilio');
  });

  test('SMTP_URL kept in SMTP_URL_FILE: a re-run does not ask for the URL, and writes no second source', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [
      ...PRODUCTION,
      '--mail',
      'smtp',
      '--smtp-url',
      'smtp://relay.example.com:587',
      '--mail-from',
      'no-reply@example.com',
    ]);
    edit(out, [
      ['SMTP_URL', ''],
      ['SMTP_URL_FILE', '/run/secrets/smtp'],
    ]);
    // Before: this threw "A value is needed for --smtp-url".
    const env = await rerun(root, out);
    assert.equal(env.get('MAIL_TRANSPORT'), 'smtp');
    assert.equal(env.get('SMTP_URL'), '');
    assert.equal(env.get('SMTP_URL_FILE'), '/run/secrets/smtp');
  });

  test('a social provider whose client secret is in a file is not asked for it; another provider still is', async () => {
    const root = fixture();
    const out = temp();
    await setup(root, out, [
      ...PRODUCTION,
      '--social',
      'google',
      '--social-client-id',
      'gid',
      '--social-client-secret',
      'gsecret-value',
    ]);
    edit(out, [
      ['GOOGLE_CLIENT_SECRET', ''],
      ['GOOGLE_CLIENT_SECRET_FILE', '/run/secrets/google'],
    ]);
    // Before: this threw "A value is needed for --social-client-secret".
    let env = await rerun(root, out);
    assert.equal(env.get('GOOGLE_CLIENT_ID'), 'gid');
    assert.equal(env.get('GOOGLE_CLIENT_SECRET'), '');
    assert.equal(env.get('GOOGLE_CLIENT_SECRET_FILE'), '/run/secrets/google');
    // The file keeps Google's secret only: GitHub's is asked, and written.
    await assert.rejects(
      setup(root, out, [
        '--target',
        'production',
        '--social',
        'github',
        '--social-client-id',
        'ghid',
      ]),
      /--social-client-secret/,
    );
    const github = await setup(root, out, [
      '--target',
      'production',
      '--social',
      'github',
      '--social-client-id',
      'ghid',
      '--social-client-secret',
      'ghsecret-value',
    ]);
    assert.equal(github.code, 0, `${github.text}\n${github.errors}`);
    env = parseEnv(read(out, 'production'));
    assert.equal(env.get('GITHUB_CLIENT_SECRET'), 'ghsecret-value');
    assert.equal(env.get('GITHUB_CLIENT_SECRET_FILE'), '');
    assert.equal(env.get('GOOGLE_CLIENT_SECRET_FILE'), '/run/secrets/google');
  });

  test('every other credential kept in a file is skipped the same way, and none is written beside it', async () => {
    const root = fixture();
    const out = temp();
    const kept = {
      CLOUDFLARE_API_TOKEN: 'cf-test-value',
      MAIL_API_KEY: 'mail-key-value',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
      TURNSTILE_SECRET_KEY: 'turnstile-secret-value',
      ANTHROPIC_API_KEY: 'sk-ant-value',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-team=key-value',
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
    };
    await setup(root, out, [
      ...PRODUCTION,
      '--mail',
      'resend',
      '--mail-api-key',
      kept.MAIL_API_KEY,
      '--mail-from',
      'no-reply@example.com',
      '--storage',
      's3',
      '--s3-bucket',
      'files',
      '--aws-access-key-id',
      'AKIA1',
      '--aws-secret-access-key',
      kept.AWS_SECRET_ACCESS_KEY,
      '--captcha',
      'turnstile',
      '--turnstile-site-key',
      'site-key',
      '--turnstile-secret-key',
      kept.TURNSTILE_SECRET_KEY,
      '--anthropic-api-key',
      kept.ANTHROPIC_API_KEY,
      '--otel-endpoint',
      'https://otel.example.com',
      '--otel-headers',
      kept.OTEL_EXPORTER_OTLP_HEADERS,
      '--sentry-dsn',
      kept.SENTRY_DSN,
    ]);
    const first = parseEnv(read(out, 'production'));
    for (const [name, value] of Object.entries(kept)) {
      assert.equal(first.get(name), value, `${name} is written on a first run`);
    }
    // Every one of them moved to a file.
    edit(
      out,
      Object.keys(kept).flatMap((name) => [
        [name, ''],
        [`${name}_FILE`, `/run/secrets/${name.toLowerCase()}`],
      ]),
    );
    const env = await rerun(root, out);
    for (const name of Object.keys(kept)) {
      assert.equal(env.get(name), '', `${name} stays empty`);
      assert.equal(
        env.get(`${name}_FILE`),
        `/run/secrets/${name.toLowerCase()}`,
        `${name}_FILE stays`,
      );
    }
    // Their questions are skipped; what they belong to is kept.
    assert.equal(env.get('MAIL_TRANSPORT'), 'resend');
    assert.equal(env.get('AWS_ACCESS_KEY_ID'), 'AKIA1');
    assert.equal(env.get('TURNSTILE_SITE_KEY'), 'site-key');
    assert.equal(
      env.get('OTEL_EXPORTER_OTLP_ENDPOINT'),
      'https://otel.example.com',
    );
  });

  test('every secret question is skipped when its variable is kept in a _FILE, and asked when the line is empty or the file is new', () => {
    const text = readFileSync(path.join(REPO, 'env.example'), 'utf8');
    const tpl = parseEnv(text);
    const base = {
      target: 'production',
      tpl,
      keys: templateKeys(text),
      hasNotes: false,
    };
    const asked = (id, answers, existing) =>
      applies(
        QUESTIONS.find((q) => q.id === id),
        answers,
        { ...base, existing, current: existing ?? tpl },
      );
    const cases = [
      ['cloudflareApiToken', {}, 'CLOUDFLARE_API_TOKEN'],
      ['smtpUrl', { mail: 'smtp' }, 'SMTP_URL'],
      ['mailApiKey', { mail: 'resend' }, 'MAIL_API_KEY'],
      ['mailApiKey', { mail: 'postmark' }, 'MAIL_API_KEY'],
      ['awsSecretAccessKey', { storage: 's3' }, 'AWS_SECRET_ACCESS_KEY'],
      ['awsSecretAccessKey', { mail: 'ses' }, 'AWS_SECRET_ACCESS_KEY'],
      ['turnstileSecretKey', { captcha: 'turnstile' }, 'TURNSTILE_SECRET_KEY'],
      ['socialClientSecret', { social: 'google' }, 'GOOGLE_CLIENT_SECRET'],
      [
        'socialClientSecret',
        { social: 'microsoft' },
        'MICROSOFT_CLIENT_SECRET',
      ],
      ['socialClientSecret', { social: 'github' }, 'GITHUB_CLIENT_SECRET'],
      ['observeAppSecret', { observe: true }, 'OBSERVE_APP_SECRET'],
      [
        'otelHeaders',
        { otelEndpoint: 'https://otel.example.com' },
        'OTEL_EXPORTER_OTLP_HEADERS',
      ],
      ['sentryDsn', {}, 'SENTRY_DSN'],
      ['anthropicApiKey', {}, 'ANTHROPIC_API_KEY'],
      ['twilioAuthToken', { sms: true }, 'TWILIO_AUTH_TOKEN'],
    ];
    // A secret question added later must be listed here.
    assert.deepEqual(
      [...new Set(cases.map(([id]) => id))].sort(),
      QUESTIONS.filter((q) => q.secret)
        .map((q) => q.id)
        .sort(),
    );
    for (const [id, answers, name] of cases) {
      const label = `${id} (${name})`;
      assert.equal(asked(id, answers, null), true, `${label}: first run`);
      assert.equal(
        asked(id, answers, new Map([[`${name}`, 'old-value']])),
        true,
        `${label}: the variable is set`,
      );
      assert.equal(
        asked(id, answers, new Map([[`${name}_FILE`, '']])),
        true,
        `${label}: empty ${name}_FILE`,
      );
      assert.equal(
        asked(id, answers, new Map([[`${name}_FILE`, '/run/secrets/x']])),
        false,
        `${label}: ${name}_FILE set`,
      );
    }
    // A provider's secret is kept in its own file only.
    assert.equal(
      asked(
        'socialClientSecret',
        { social: 'github' },
        new Map([['GOOGLE_CLIENT_SECRET_FILE', '/run/secrets/x']]),
      ),
      true,
    );
  });

  test('development is not asked these: its template keeps its own lines', async () => {
    const root = fixture();
    const out = temp();
    const { code, errors } = await setup(root, out, [
      '--target',
      'development',
      '--observe',
    ]);
    assert.equal(code, 0);
    assert.equal(errors, '');
    const env = parseEnv(read(out, 'development'));
    assert.equal(env.get('OBSERVE_APP_KEY'), '');
    assert.equal(env.has('PUSH_PROVIDER'), false);
  });

  test('the real web-push package makes the pair (when installed)', async (t) => {
    const { generateVapidKeys } = await import('./vapid.mjs');
    const pair = generateVapidKeys();
    if (!pair) return t.skip('web-push is not installed');
    assert.match(pair.publicKey, /^[A-Za-z0-9_-]{87}$/);
    assert.match(pair.privateKey, /^[A-Za-z0-9_-]{43}$/);
  });

  test('env.example: the AI key is an active empty line, with its _FILE named', () => {
    const text = readFileSync(path.join(REPO, 'env.example'), 'utf8');
    assert.equal(parseEnv(text).get('ANTHROPIC_API_KEY'), '');
    assert.match(text, /^ANTHROPIC_API_KEY_FILE=$/m);
  });
});
