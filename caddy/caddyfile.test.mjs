// The Caddyfile's behaviour, run by a real Caddy:
//   CADDY_BIN=/path/to/caddy node --test caddy/caddyfile.test.mjs
// (CI's caddy-image job takes the binary out of the image it built; without a
// binary the tests are skipped.) The real Caddyfile is used with four edits
// that make it runnable without TLS, DNS or Docker: the `tls` block goes, the
// site address becomes a local http one, the `/srv` directories become temp
// directories, and `api:3000` becomes a stub server. Every edit must match, or
// the test fails (a Caddyfile that changed shape must not pass by testing
// nothing).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const caddyBin = process.env.CADDY_BIN || 'caddy';
const available =
  spawnSync(caddyBin, ['version'], { encoding: 'utf8' }).status === 0;
// A binary named by CADDY_BIN that does not run is an error (CI must not pass
// by skipping); with none named, the tests are skipped where there is no caddy.
if (process.env.CADDY_BIN && !available) {
  throw new Error(`CADDY_BIN=${process.env.CADDY_BIN} does not run`);
}
const skip = available ? false : 'no caddy binary (set CADDY_BIN)';

const caddyfile = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8');
const maintenancePage = fileURLToPath(
  new URL('./maintenance.html', import.meta.url),
);

/** `text` with every `from` replaced; a miss throws. */
function replace(text, from, to) {
  const out =
    typeof from === 'string'
      ? text.replaceAll(from, to)
      : text.replace(from, to);
  assert.notEqual(
    out,
    text,
    `the Caddyfile no longer has ${from}: update this test with it`,
  );
  return out;
}

/** A free port: asked of the system, then given back. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The Caddyfile as this test can run it. */
function testable({ port, apiPort, dirs }) {
  let text = caddyfile;
  // The ACME DNS challenge needs the Cloudflare module and a token.
  text = replace(text, /^\ttls \{\n(?:\t\t.*\n|\n)*?\t\}\n/m, '');
  text = replace(text, '{$APP_DOMAIN}', `http://127.0.0.1:${port}`);
  text = replace(text, 'persist_config off', 'persist_config off\n\tadmin off');
  for (const name of ['web', 'maintenance', 'security']) {
    text = replace(text, `/srv/${name}`, dirs[name]);
  }
  // The API's replicas: Docker's DNS name and port, here one local stub.
  text = replace(text, 'name api\n', 'name 127.0.0.1\n');
  text = replace(text, 'port 3000\n', `port ${apiPort}\n`);
  return text;
}

/** Caddy running the testable Caddyfile with this environment; `stop()` ends it. */
async function startCaddy(env) {
  const root = mkdtempSync(join(tmpdir(), 'caddyfile-test-'));
  const dirs = {
    web: join(root, 'web'),
    maintenance: join(root, 'maintenance'),
    security: join(root, 'security'),
  };
  mkdirSync(join(dirs.web, 'assets'), { recursive: true });
  writeFileSync(
    join(dirs.web, 'index.html'),
    '<!doctype html><title>app shell</title>',
  );
  writeFileSync(join(dirs.web, 'assets', 'app.js'), 'export {};');
  mkdirSync(dirs.maintenance);
  copyFileSync(maintenancePage, join(dirs.maintenance, 'index.html'));
  mkdirSync(join(dirs.security, '.well-known'), { recursive: true });
  writeFileSync(
    join(dirs.security, '.well-known', 'security.txt'),
    'Contact: mailto:ci@example.com\n',
  );

  const api = createServer((request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end(`api ${request.method} ${request.url}`);
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const file = join(root, 'Caddyfile');
  writeFileSync(file, testable({ port, apiPort: api.address().port, dirs }));

  const child = spawn(
    caddyBin,
    ['run', '--config', file, '--adapter', 'caddyfile'],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'),
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let log = '';
  child.stderr.on('data', (chunk) => (log += chunk));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`caddy exited (${child.exitCode}):\n${log}`);
    }
    try {
      await fetch(base, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`caddy did not answer in time:\n${log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    base,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) =>
        child.exitCode === null ? child.once('exit', resolve) : resolve(),
      );
      await new Promise((resolve) => api.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A response's status, headers and text. */
async function get(caddy, path, init) {
  const response = await fetch(caddy.base + path, {
    redirect: 'manual',
    ...init,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

/** What the web app's every response carries (the web app's `header` block). */
function assertSecurityHeaders(response) {
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /default-src 'self'/,
  );
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
}

const APP = 'app shell';
const PAGE = 'Down for maintenance';

describe('the web app, MAINTENANCE_PAGE unset', { skip }, () => {
  let caddy;
  before(async () => (caddy = await startCaddy({})));
  after(() => caddy.stop());

  it('serves the app: the shell for its routes, the assets for a year', async () => {
    for (const path of ['/', '/sign-in', '/account/profile?tab=1']) {
      const response = await get(caddy, path);
      assert.equal(response.status, 200, path);
      assert.match(response.body, new RegExp(APP), path);
      assert.equal(response.headers.get('cache-control'), 'no-cache', path);
      assertSecurityHeaders(response);
    }
    const asset = await get(caddy, '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await get(caddy, '/assets/missing.js')).status, 404);
  });

  it('sends the API its paths, and answers /metrics with 404', async () => {
    assert.match(
      (await get(caddy, '/v1/auth/me')).body,
      /^api GET \/v1\/auth\/me$/,
    );
    assert.equal((await get(caddy, '/metrics')).status, 404);
    assert.equal((await get(caddy, '/.well-known/security.txt')).status, 200);
  });
});

describe('the web app, MAINTENANCE_PAGE=on', { skip }, () => {
  let caddy;
  before(async () => (caddy = await startCaddy({ MAINTENANCE_PAGE: 'on' })));
  after(() => caddy.stop());

  it('answers the static page, 503, for every path of the app', async () => {
    for (const path of [
      '/',
      '/sign-in?redirect=%2Fnotes',
      '/account/profile',
      '/assets/app.js',
      '/assets/missing.js',
      '/manifest.webmanifest',
    ]) {
      const response = await get(caddy, path);
      assert.equal(response.status, 503, path);
      assert.match(response.body, new RegExp(PAGE), path);
      assert.doesNotMatch(response.body, new RegExp(APP), path);
      assert.match(
        response.headers.get('content-type') ?? '',
        /^text\/html/,
        path,
      );
      assert.equal(response.headers.get('retry-after'), '30', path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assertSecurityHeaders(response);
    }
  });

  it('serves no shell to a write to the app either (file_server refuses it, 405)', async () => {
    const response = await get(caddy, '/', { method: 'POST', body: 'x' });
    assert.equal(response.status, 405);
    assert.doesNotMatch(response.body, new RegExp(APP));
  });

  it('leaves the API its paths, and /metrics and security.txt theirs', async () => {
    for (const path of [
      '/v1/auth/me',
      '/health',
      '/health/live',
      '/api',
      '/api-json',
      '/files/a',
      '/socket.io/?EIO=4',
    ]) {
      const response = await get(caddy, path);
      assert.equal(response.status, 200, path);
      assert.match(response.body, /^api GET /, path);
    }
    assert.equal((await get(caddy, '/metrics')).status, 404);
    assert.equal((await get(caddy, '/.well-known/security.txt')).status, 200);
  });
});

describe(
  'the web app, MAINTENANCE_PAGE set to anything but "on"',
  { skip },
  () => {
    for (const value of ['off', '', 'true', '1']) {
      it(`serves the app for ${JSON.stringify(value)}`, async () => {
        const caddy = await startCaddy({ MAINTENANCE_PAGE: value });
        try {
          const response = await get(caddy, '/');
          assert.equal(response.status, 200);
          assert.match(response.body, new RegExp(APP));
        } finally {
          await caddy.stop();
        }
      });
    }
  },
);

/** The `img-src` source list of a response's Content-Security-Policy. */
const imgSources = (response) =>
  /(?:^|;)\s*img-src ([^;]*)/
    .exec(response.headers.get('content-security-policy') ?? '')?.[1]
    ?.trim()
    .split(/\s+/);

describe('the web app, FILES_ORIGIN unset', { skip }, () => {
  let caddy;
  before(async () => (caddy = await startCaddy({})));
  after(() => caddy.stop());

  it('lets images come from the app and data: URLs only', async () => {
    assert.deepEqual(imgSources(await get(caddy, '/')), ["'self'", 'data:']);
  });
});

describe('the web app, FILES_ORIGIN set', { skip }, () => {
  const bucket = 'https://files.s3.eu-west-1.amazonaws.com';
  const cdn = 'https://cdn.example.com:8443';
  let caddy;
  before(async () => (caddy = await startCaddy({ FILES_ORIGIN: bucket })));
  after(() => caddy.stop());

  it("adds the bucket's origin to img-src, and to nothing else", async () => {
    const response = await get(caddy, '/');
    assert.deepEqual(imgSources(response), ["'self'", 'data:', bucket]);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.equal(policy.split(bucket).length, 2);
    assert.match(policy, /connect-src 'self';/);
  });

  it('adds every origin of a list', async () => {
    const two = await startCaddy({ FILES_ORIGIN: `${bucket} ${cdn}` });
    try {
      assert.deepEqual(imgSources(await get(two, '/')), [
        "'self'",
        'data:',
        bucket,
        cdn,
      ]);
    } finally {
      await two.stop();
    }
  });
});

describe('the entrypoint checks FILES_ORIGIN', () => {
  const entrypoint = fileURLToPath(new URL('./entrypoint.sh', import.meta.url));
  const run = (FILES_ORIGIN) =>
    spawnSync('sh', [entrypoint, 'true'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: 'ci',
        ...(FILES_ORIGIN === undefined ? {} : { FILES_ORIGIN }),
      },
    });

  it('starts without it, with an empty one, and with https origins', () => {
    for (const value of [
      undefined,
      '',
      'https://files.s3.eu-west-1.amazonaws.com',
      'https://a.example.com https://b.example.com:8443',
      '  https://a.example.com  ',
    ]) {
      const result = run(value);
      assert.equal(
        result.status,
        0,
        `${JSON.stringify(value)}: ${result.stderr}`,
      );
    }
  });

  it('refuses anything that is not an https origin: it goes into the policy as written', () => {
    for (const value of [
      'http://files.example.com',
      'files.example.com',
      'https://',
      'https://files.example.com/bucket',
      'https://*.example.com',
      "https://a.example.com; script-src 'unsafe-inline'",
      'https://a.example.com; script-src',
      "https://a.example.com'",
      'https://a.example.com,https://b.example.com',
      "'self'",
    ]) {
      const result = run(value);
      assert.equal(result.status, 1, JSON.stringify(value));
      assert.match(result.stderr, /FILES_ORIGIN: .* is not an https origin/);
    }
  });
});

describe('the maintenance page', () => {
  const page = readFileSync(maintenancePage, 'utf8');

  it('has the five languages of the web app', () => {
    for (const language of ['en', 'de', 'ar', 'zh', 'ms']) {
      assert.match(page, new RegExp(`lang="${language}"`), language);
    }
    assert.match(page, /lang="ar" dir="rtl"/);
  });

  it('needs nothing but itself: no script, no request, no link out', () => {
    assert.doesNotMatch(
      page,
      /<script|<link|<img|<iframe|src=|href=|@import|url\(/i,
    );
  });

  it('reloads by itself at the Retry-After the Caddyfile sends', () => {
    assert.match(page, /<meta http-equiv="refresh" content="30" \/>/);
    assert.match(caddyfile, /header Retry-After "30"/);
  });
});
