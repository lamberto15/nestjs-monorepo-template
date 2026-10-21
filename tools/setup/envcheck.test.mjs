// pnpm env:check's tests: node --test tools/setup/envcheck.test.mjs. Every
// test works on a copy of the real templates in a temp directory (--root): no
// real .env is read or written.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkTemplate,
  compareEnv,
  emptyRequired,
  REQUIRED,
  run,
} from './envcheck.mjs';
import { parseEnv, TARGETS } from './envfile.mjs';
import { run as setupRun } from './setup.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const template = (target) =>
  readFileSync(path.join(REPO, TARGETS[target].template), 'utf8');

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A repository root holding the real templates, and the files given (path -> text). */
function root(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'envcheck-test-'));
  temps.push(dir);
  for (const { template: relative } of Object.values(TARGETS)) {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(
      path.join(dir, relative),
      readFileSync(path.join(REPO, relative)),
    );
  }
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), text);
  }
  return dir;
}

/** Runs the check, collecting its output. */
function check(argv) {
  const out = [];
  const err = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A production file the wizard wrote from the real template. */
async function written() {
  const dir = mkdtempSync(path.join(tmpdir(), 'envcheck-out-'));
  temps.push(dir);
  const code = await setupRun(
    [
      '--yes',
      '--target',
      'production',
      '--app-domain',
      'api.test.example',
      '--acme-email',
      'ops@example.com',
      '--cloudflare-api-token',
      'cf-test-value',
      '--no-remove-notes',
      '--out',
      dir,
    ],
    { out: () => {}, err: () => {}, isTTY: false },
  );
  assert.equal(code, 0);
  return path.join(dir, '.env');
}

describe('the requirements', () => {
  test('a placeholder, an empty value or none is unmet; a _FILE or a managed URL meets one', () => {
    const unmet = (text) =>
      emptyRequired('production', parseEnv(text)).map((r) => r.any[0]);
    assert.equal(unmet('').length, REQUIRED.production.length);
    const base = [
      'APP_DOMAIN=api.example.com',
      'ACME_EMAIL=ops@acme.io',
      'CLOUDFLARE_API_TOKEN_FILE=/run/secrets/cf',
      'DATABASE_OWNER_URL=postgres://owner@db/app',
      'DATABASE_URL_FILE=/run/secrets/url',
      'MFA_ENCRYPTION_KEYS=k',
      'DATA_ENCRYPTION_KEYS=k',
      'BLIND_INDEX_KEYS=k',
    ].join('\n');
    assert.deepEqual(unmet(base), ['APP_DOMAIN']);
    assert.deepEqual(unmet(base.replace('api.example.com', 'api.acme.io')), []);
    assert.deepEqual(
      unmet(base.replace('ACME_EMAIL=ops@acme.io', 'ACME_EMAIL=')),
      ['APP_DOMAIN', 'ACME_EMAIL'],
    );
  });

  test('every REQUIRED variable is an active line of its template', () => {
    for (const target of Object.keys(REQUIRED)) {
      assert.deepEqual(checkTemplate(target, template(target)), {
        repeated: [],
        unnamed: [],
      });
      const env = parseEnv(template(target));
      for (const { any } of REQUIRED[target]) {
        assert.ok(env.has(any[0]), `${target}: ${any[0]}`);
      }
    }
  });

  test('a template that sets a name twice or leaves a REQUIRED one out is found', () => {
    const found = checkTemplate(
      'development',
      'DATA_ENCRYPTION_KEYS=\nDATA_ENCRYPTION_KEYS=\n',
    );
    assert.deepEqual(found.repeated, ['DATA_ENCRYPTION_KEYS']);
    assert.deepEqual(
      found.unnamed.map((r) => r.any[0]),
      ['BLIND_INDEX_KEYS'],
    );
  });
});

describe('comparing a file', () => {
  test('lists what the template has and the file lacks, what it does not know, and what is set twice', () => {
    const found = compareEnv(
      'development',
      'A=1\nB=2\n# C=3\nDATA_ENCRYPTION_KEYS=\nBLIND_INDEX_KEYS=\n',
      'A=x\nMINE=1\nMINE=2\nDATA_ENCRYPTION_KEYS=k\nBLIND_INDEX_KEYS=\n',
    );
    assert.deepEqual(found.missing, ['B']);
    assert.deepEqual(found.unknown, ['MINE']);
    assert.deepEqual(found.repeated, ['MINE']);
    assert.deepEqual(
      found.empty.map((r) => r.any[0]),
      ['BLIND_INDEX_KEYS'],
    );
  });
});

describe('pnpm env:check', () => {
  test('a file the wizard wrote is ok, strictly too', async () => {
    const file = await written();
    const result = check(['--file', file, '--strict']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /ok: every variable is there/);
  });

  test('a stale file lists the missing names and exits 0; --strict exits 1', async () => {
    const file = await written();
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^(WEBHOOKS|PUSH_PROVIDER|SMS_PROVIDER)=/.test(line))
      .join('\n');
    writeFileSync(file, `${text}\nMY_OWN=1\n`);
    const loose = check(['--file', file]);
    assert.equal(loose.code, 0);
    assert.match(loose.out, /3 variables of env\.example not in the file/);
    assert.match(
      loose.out,
      /WEBHOOKS, .*PUSH_PROVIDER|PUSH_PROVIDER.*WEBHOOKS/s,
    );
    assert.match(loose.out, /1 variable the template does not name/);
    assert.match(loose.out, /MY_OWN/);
    assert.equal(check(['--file', file, '--strict']).code, 1);
  });

  test('a REQUIRED variable that is empty exits 1, whatever the flags', async () => {
    const file = await written();
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /^CLOUDFLARE_API_TOKEN=.*$/m,
        'CLOUDFLARE_API_TOKEN=',
      ),
    );
    const result = check(['--file', file]);
    assert.equal(result.code, 1);
    assert.match(
      result.out,
      /REQUIRED, empty: CLOUDFLARE_API_TOKEN \(or CLOUDFLARE_API_TOKEN_FILE\)/,
    );
  });

  test('the placeholder APP_DOMAIN counts as empty', async () => {
    const file = await written();
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /^APP_DOMAIN=.*$/m,
        'APP_DOMAIN=api.example.com',
      ),
    );
    const result = check(['--file', file]);
    assert.equal(result.code, 1);
    assert.match(
      result.out,
      /REQUIRED, empty or api\.example\.com: APP_DOMAIN/,
    );
  });

  test('without --file it checks .env and .env.development under --root, whichever exist', () => {
    const dir = root({
      '.env': 'APP_DOMAIN=api.acme.io\n',
      'apps/api/.env.development': template('development')
        .replace('DATA_ENCRYPTION_KEYS=\n', 'DATA_ENCRYPTION_KEYS=k\n')
        .replace('BLIND_INDEX_KEYS=\n', 'BLIND_INDEX_KEYS=k\n'),
    });
    const result = check(['--root', dir]);
    assert.match(result.out, /\.env \(production\), against env\.example:/);
    assert.match(
      result.out,
      /apps\/api\/\.env\.development \(development\), against apps\/api\/env\.development\.example:\n  ok/,
    );
    assert.equal(result.code, 1);

    const only = root({ '.env': 'APP_DOMAIN=api.acme.io\n' });
    assert.doesNotMatch(check(['--root', only]).out, /development\)/);
  });

  test('no file at all, or the one asked for missing, exits 1 with the way to write it', () => {
    const bare = root();
    const none = check(['--root', bare]);
    assert.equal(none.code, 1);
    assert.match(none.err, /No env file to check.*pnpm setup writes one/);
    const asked = check(['--root', bare, '--target', 'production']);
    assert.equal(asked.code, 1);
    assert.match(
      asked.err,
      /does not exist \(pnpm setup --target production writes it\)/,
    );
  });

  test('--templates checks the real templates (the CI step)', () => {
    const result = check(['--templates']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /env\.example: ok\./);
    assert.match(result.out, /env\.development\.example: ok\./);
  });

  test('--templates fails on a template with a name twice or a REQUIRED one missing', () => {
    const dir = root({
      'env.example': 'APP_DOMAIN=a\nAPP_DOMAIN=b\n',
    });
    const result = check([
      '--templates',
      '--root',
      dir,
      '--target',
      'production',
    ]);
    assert.equal(result.code, 1);
    assert.match(result.err, /env\.example: set more than once: APP_DOMAIN/);
    assert.match(result.err, /does not name the REQUIRED ACME_EMAIL/);
  });

  test('a wrong target is an error', () => {
    assert.throws(
      () => run(['--target', 'staging']),
      /development or production/,
    );
  });
});
