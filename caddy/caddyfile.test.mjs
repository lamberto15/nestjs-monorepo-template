// The Caddyfile's behaviour, run by a real Caddy:
//   CADDY_BIN=/path/to/caddy node --test caddy/caddyfile.test.mjs
// (CI's caddy-image job takes the binary out of the image it built; without a
// binary those tests are skipped. The Helm workflow runs the file too, for the
// tests that need no Caddy: the chart's copy of the web app's Caddyfile must
// match this one.) The real Caddyfile is used with four edits
// that make it runnable without TLS, DNS or Docker: the `tls` block goes, the
// site address becomes a local http one, the `/srv` directories become temp
// directories, and `api:3000` becomes a stub server. Every edit must match, or
// the test fails (a Caddyfile that changed shape must not pass by testing
// nothing). Caddy runs as it is, or through caddy/entrypoint.sh, as the image
// starts it, where a suite tests what the entrypoint hands it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

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
const entrypoint = fileURLToPath(new URL('./entrypoint.sh', import.meta.url));
const maintenancePage = fileURLToPath(
  new URL('./maintenance.html', import.meta.url),
);
// What the image's build runs on the built assets (caddy/Dockerfile).
const precompressScript = fileURLToPath(
  new URL('../apps/web/scripts/precompress.mjs', import.meta.url),
);

// The web app's files, over the 512 bytes under which Caddy's encode sends a
// response as it is (encode docs, minimum_length): the shell names its
// scripts, as the built one does.
const SHELL = `<!doctype html><title>app shell</title>\n${'<link rel="modulepreload" crossorigin href="/assets/app.js">\n'.repeat(20)}`;
const APP_JS = `export const words = [${'"compressible", '.repeat(80)}];\n`;
// The API's answers the stub gives: a record with its strong ETag (a GET of
// an @Etag() route), and the ops log's event stream (GET /v1/ops/events,
// with the headers Nest's @Sse() sends).
const NOTE = JSON.stringify({
  id: '0190f7a2-0000-7000-8000-000000000001',
  title: 'A note',
  body: 'compressible '.repeat(60),
});
const NOTE_ETAG = '"mZ1kQ0bH5d1Yh9xVv2u3q8r7s6t"';

/** Runs apps/web/scripts/precompress.mjs on `dir`, as the image's build does. */
function precompress(dir) {
  const run = spawnSync(process.execPath, [precompressScript, dir], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
}

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
    text = replace(
      text,
      name === 'security' ? '/tmp/caddy-security' : `/srv/${name}`,
      dirs[name],
    );
  }
  // The API's replicas: Docker's DNS name and port, here one local stub.
  text = replace(text, 'name api\n', 'name 127.0.0.1\n');
  text = replace(text, 'port 3000\n', `port ${apiPort}\n`);
  return text;
}

/**
 * Caddy running the testable Caddyfile with this environment; `stop()` ends it.
 * `viaEntrypoint`: started by caddy/entrypoint.sh, which execs it.
 */
async function startCaddy(env, { viaEntrypoint = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'caddyfile-test-'));
  const dirs = {
    web: join(root, 'web'),
    maintenance: join(root, 'maintenance'),
    security: join(root, 'security'),
  };
  mkdirSync(join(dirs.web, 'assets'), { recursive: true });
  writeFileSync(join(dirs.web, 'index.html'), SHELL);
  writeFileSync(join(dirs.web, 'assets', 'app.js'), APP_JS);
  precompress(join(dirs.web, 'assets'));
  mkdirSync(dirs.maintenance);
  copyFileSync(maintenancePage, join(dirs.maintenance, 'index.html'));
  mkdirSync(join(dirs.security, '.well-known'), { recursive: true });
  writeFileSync(
    join(dirs.security, '.well-known', 'security.txt'),
    'Contact: mailto:ci@example.com\n',
  );

  const api = createServer((request, response) => {
    if (request.url === '/v1/ops/events') {
      // The first event, then nothing until the client goes: a proxy that
      // held the response back would never pass it on.
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control':
          'private, no-cache, no-store, must-revalidate, max-age=0, no-transform',
        'x-accel-buffering': 'no',
      });
      response.write('data: {"type":"log","message":"first"}\n\n');
      return;
    }
    if (request.url === '/v1/notes/1') {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('etag', NOTE_ETAG);
      response.setHeader('cache-control', 'private, no-cache');
      response.end(NOTE);
      return;
    }
    response.setHeader('content-type', 'text/plain');
    response.end(`api ${request.method} ${request.url}`);
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const file = join(root, 'Caddyfile');
  writeFileSync(file, testable({ port, apiPort: api.address().port, dirs }));

  const run = [caddyBin, 'run', '--config', file, '--adapter', 'caddyfile'];
  const [command, ...args] = viaEntrypoint ? ['sh', entrypoint, ...run] : run;
  const child = spawn(command, args, {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'),
      // The entrypoint requires the token; the testable Caddyfile has no `tls`.
      ...(viaEntrypoint ? { CLOUDFLARE_API_TOKEN: 'ci' } : {}),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

/**
 * A response's status, headers (lower-case names, as node:http gives them)
 * and body as it came, not decoded: what a browser asking with
 * `accept-encoding` gets (fetch would decode it).
 */
function raw(caddy, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sent = request(caddy.base + path, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.on('error', reject);
    });
    sent.on('error', reject);
    sent.end();
  });
}

/** The tokens of a response's Vary. */
const vary = (headers) =>
  (headers.vary ?? '').split(',').map((token) => token.trim().toLowerCase());

/** The web app's headers besides the policy, as the `header` block sets them. */
const WEB_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
};

/** What the web app's every response carries (the web app's `header` block). */
function assertSecurityHeaders(response) {
  const header = (name) =>
    typeof response.headers.get === 'function'
      ? response.headers.get(name)
      : response.headers[name];
  const policy = header('content-security-policy') ?? '';
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  for (const [name, value] of Object.entries(WEB_HEADERS)) {
    assert.equal(header(name), value, name);
  }
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
    assertSecurityHeaders(asset);
    const missing = await get(caddy, '/assets/missing.js');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(
      missing.headers.get('cache-control') ?? '',
      /immutable/,
    );
    assertSecurityHeaders(missing);
  });

  it("sends the API a stored file's signed link: the local disk signs /files?key=…, whose path is /files itself", async () => {
    // The link as the local disk issues it (@nestjs/storage, signedUrl): the
    // key and the signature are in the query, so the path has no segment
    // after /files. Matched by /files/* alone, it was the app shell, 200.
    const query = 'key=tenants%2Ft%2Fdocuments%2Fd%2Fnote.pdf&signature=s';
    for (const method of ['GET', 'PUT']) {
      const response = await get(caddy, `/files?${query}`, { method });
      assert.equal(response.status, 200, method);
      assert.equal(response.body, `api ${method} /files?${query}`, method);
    }
    assert.match((await get(caddy, '/files/a?signature=s')).body, /^api GET /);
    // Whole segments: paths that merely start with "files" stay the web app's.
    for (const path of ['/files-list', '/filesystem', '/files.json']) {
      assert.match((await get(caddy, path)).body, new RegExp(APP), path);
    }
  });

  it('sends the API its paths, and answers /metrics with 404', async () => {
    const response = await get(caddy, '/v1/auth/me');
    assert.match(response.body, /^api GET \/v1\/auth\/me$/);
    // The API's own headers (helmet) only: none of the web app's.
    for (const name of [
      'content-security-policy',
      ...Object.keys(WEB_HEADERS),
    ]) {
      assert.equal(response.headers.get(name), null, name);
    }
    assert.equal((await get(caddy, '/metrics')).status, 404);
    assert.equal((await get(caddy, '/.well-known/security.txt')).status, 200);
  });
});

describe('the web app compressed, the API as it is', { skip }, () => {
  let caddy;
  before(async () => (caddy = await startCaddy({})));
  after(() => caddy.stop());

  it('compresses the shell as it sends it: zstd, else gzip (no brotli encoder), else nothing', async () => {
    for (const path of ['/', '/sign-in']) {
      const zstd = await raw(caddy, path, {
        headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
      });
      assert.equal(zstd.status, 200, path);
      assert.equal(zstd.headers['content-encoding'], 'zstd', path);
      // A zstd frame's magic number (RFC 8878).
      assert.equal(zstd.body.readUInt32LE(0), 0xfd2fb528, path);
      assert.ok(vary(zstd.headers).includes('accept-encoding'), path);
      assertSecurityHeaders(zstd);

      const gzip = await raw(caddy, path, {
        headers: { 'accept-encoding': 'gzip' },
      });
      assert.equal(gzip.headers['content-encoding'], 'gzip', path);
      assert.equal(gunzipSync(gzip.body).toString(), SHELL, path);

      for (const accept of ['br', undefined]) {
        const plain = await raw(caddy, path, {
          headers: accept ? { 'accept-encoding': accept } : {},
        });
        assert.equal(plain.headers['content-encoding'], undefined, path);
        assert.equal(plain.body.toString(), SHELL, path);
      }
    }
  });

  it('sends the built assets precompressed: the .br, else the .gz, else the file', async () => {
    const asset = (accept) =>
      raw(caddy, '/assets/app.js', {
        headers: accept ? { 'accept-encoding': accept } : {},
      });
    const br = await asset('gzip, deflate, br, zstd');
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(brotliDecompressSync(br.body).toString(), APP_JS);
    assert.match(br.headers['content-type'] ?? '', /javascript/);
    assert.match(br.headers['cache-control'] ?? '', /immutable/);
    assert.ok(vary(br.headers).includes('accept-encoding'));
    assertSecurityHeaders(br);

    const gzip = await asset('gzip');
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gzip.body).toString(), APP_JS);
    assert.match(gzip.headers['cache-control'] ?? '', /immutable/);

    const plain = await asset(undefined);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), APP_JS);

    // A missing asset: the 404 as before, nothing compressed.
    const missing = await raw(caddy, '/assets/missing.js', {
      headers: { 'accept-encoding': 'gzip, br, zstd' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['content-encoding'], undefined);
  });

  it("passes the API's responses as they are: not compressed, the strong ETag untouched", async () => {
    // Caddy's encode would send "<tag>-zstd" and take the suffix off an
    // If-None-Match only: a write's If-Match would carry it to the API.
    const response = await raw(caddy, '/v1/notes/1', {
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers.etag, NOTE_ETAG);
    assert.equal(response.body.toString(), NOTE);
  });

  it('streams the ops log as it comes (text/event-stream): no buffering, no compression', async () => {
    // The stub sends one event and keeps the stream open: it must arrive.
    const { headers, first } = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the first event never came through')),
        5_000,
      );
      const sent = request(
        `${caddy.base}/v1/ops/events`,
        {
          headers: {
            accept: 'text/event-stream',
            'accept-encoding': 'gzip, br, zstd',
          },
        },
        (response) => {
          response.once('data', (chunk) => {
            clearTimeout(timer);
            resolve({ headers: response.headers, first: chunk.toString() });
            sent.destroy();
          });
        },
      );
      sent.on('error', (error) => {
        if (!sent.destroyed) reject(error);
      });
      sent.end();
    });
    assert.match(headers['content-type'] ?? '', /^text\/event-stream/);
    assert.equal(headers['content-encoding'], undefined);
    assert.equal(first, 'data: {"type":"log","message":"first"}\n\n');
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
      '/files?key=a&signature=s',
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

/** A directive's source list in a response's Content-Security-Policy. */
const sources = (response, directive) =>
  new RegExp(`(?:^|;)\\s*${directive} ([^;]*)`)
    .exec(response.headers.get('content-security-policy') ?? '')?.[1]
    ?.trim()
    .split(/\s+/);
const connectSources = (response) => sources(response, 'connect-src');
const imgSources = (response) => sources(response, 'img-src');

const bucket = 'https://files.s3.eu-west-1.amazonaws.com';
const cdn = 'https://cdn.example.com:8443';

describe('the web app, WEB_FILES_ORIGINS unset', { skip }, () => {
  let caddy;
  before(async () => (caddy = await startCaddy({})));
  after(() => caddy.stop());

  it('connects to this origin only, and takes images from it, data: and blob: URLs', async () => {
    const response = await get(caddy, '/');
    assert.deepEqual(connectSources(response), ["'self'"]);
    assert.deepEqual(imgSources(response), ["'self'", 'data:', 'blob:']);
  });
});

describe(
  'the web app, WEB_FILES_ORIGINS set (caddy/entrypoint.sh sets it)',
  { skip },
  () => {
    let caddy;
    before(
      async () => (caddy = await startCaddy({ WEB_FILES_ORIGINS: bucket })),
    );
    after(() => caddy.stop());

    it('names the origin in connect-src and img-src, on every response of the app, and nowhere else', async () => {
      for (const path of ['/', '/sign-in', '/assets/app.js']) {
        const response = await get(caddy, path);
        assert.deepEqual(connectSources(response), ["'self'", bucket], path);
        assert.deepEqual(
          imgSources(response),
          ["'self'", 'data:', 'blob:', bucket],
          path,
        );
        const policy = response.headers.get('content-security-policy') ?? '';
        assert.equal(policy.split(bucket).length, 3, path); // twice
        assertSecurityHeaders(response);
      }
    });

    it('names every origin of a list in both', async () => {
      const two = await startCaddy({ WEB_FILES_ORIGINS: `${bucket} ${cdn}` });
      try {
        const response = await get(two, '/');
        assert.deepEqual(connectSources(response), ["'self'", bucket, cdn]);
        assert.deepEqual(imgSources(response), [
          "'self'",
          'data:',
          'blob:',
          bucket,
          cdn,
        ]);
      } finally {
        await two.stop();
      }
    });
  },
);

describe('the web app started by caddy/entrypoint.sh', { skip }, () => {
  /** The policy's connect-src and img-src, Caddy started with this environment. */
  async function policyWith(env) {
    const caddy = await startCaddy(env, { viaEntrypoint: true });
    try {
      const response = await get(caddy, '/');
      return {
        connect: connectSources(response),
        img: imgSources(response),
      };
    } finally {
      await caddy.stop();
    }
  }
  const s3 = {
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'files',
    S3_REGION: 'eu-west-1',
  };

  it("puts the bucket's origin, derived from the S3 settings, in connect-src and img-src", async () => {
    assert.deepEqual(await policyWith(s3), {
      connect: ["'self'", bucket],
      img: ["'self'", 'data:', 'blob:', bucket],
    });
  });

  it("adds FILES_ORIGIN after the bucket's origin, in both", async () => {
    assert.deepEqual(await policyWith({ ...s3, FILES_ORIGIN: cdn }), {
      connect: ["'self'", bucket, cdn],
      img: ["'self'", 'data:', 'blob:', bucket, cdn],
    });
  });

  it("scopes a path-style bucket to its path in both, not the shared host's every bucket", async () => {
    const pathStyle = 'https://s3.eu-west-1.amazonaws.com/my.files/';
    assert.deepEqual(await policyWith({ ...s3, S3_BUCKET: 'my.files' }), {
      connect: ["'self'", pathStyle],
      img: ["'self'", 'data:', 'blob:', pathStyle],
    });
  });

  it('adds nothing with the local driver, whatever WEB_FILES_ORIGINS the environment held', async () => {
    assert.deepEqual(
      await policyWith({
        STORAGE_DRIVER: 'local',
        S3_BUCKET: 'files',
        S3_REGION: 'eu-west-1',
        WEB_FILES_ORIGINS: "'unsafe-inline'",
      }),
      { connect: ["'self'"], img: ["'self'", 'data:', 'blob:'] },
    );
  });
});

/** What caddy/entrypoint.sh hands Caddy as WEB_FILES_ORIGINS, what it said, and its exit status. */
function filesOrigins(env) {
  const run = spawnSync(
    'sh',
    [entrypoint, 'sh', '-c', 'printf %s "$WEB_FILES_ORIGINS"'],
    {
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: 'ci', ...env },
      encoding: 'utf8',
    },
  );
  return { status: run.status, value: run.stdout, warning: run.stderr };
}

describe("the bucket origin caddy/entrypoint.sh derives from the app's S3 settings", () => {
  /** WEB_FILES_ORIGINS and the warning, for an environment the entrypoint accepts. */
  function derive(env) {
    const { status, value, warning } = filesOrigins(env);
    assert.equal(status, 0, warning);
    return { value, warning };
  }
  const s3 = { STORAGE_DRIVER: 's3', S3_BUCKET: 'files' };

  it('adds none with the local driver, or without a bucket', () => {
    assert.equal(derive({}).value, '');
    assert.equal(
      derive({
        STORAGE_DRIVER: 'local',
        S3_BUCKET: 'files',
        S3_REGION: 'eu-west-1',
      }).value,
      '',
    );
    assert.equal(
      derive({ STORAGE_DRIVER: 's3', S3_REGION: 'eu-west-1' }).value,
      '',
    );
  });

  // The sources S3Disk (@nestjs/storage) signs its URLs for: the bucket in
  // front of the host, or, with path style, the host and the bucket's path
  // (never the bare host: on AWS and other shared stores it serves every
  // customer's buckets).
  const cases = [
    [
      'AWS, from S3_REGION',
      { ...s3, S3_REGION: 'eu-west-1' },
      'https://files.s3.eu-west-1.amazonaws.com',
    ],
    [
      'AWS, from AWS_REGION',
      { ...s3, AWS_REGION: 'us-east-2' },
      'https://files.s3.us-east-2.amazonaws.com',
    ],
    [
      'S3_REGION before AWS_REGION',
      { ...s3, S3_REGION: 'eu-west-1', AWS_REGION: 'us-east-2' },
      'https://files.s3.eu-west-1.amazonaws.com',
    ],
    [
      'R2 (an endpoint, the region "auto")',
      {
        ...s3,
        S3_REGION: 'auto',
        S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      },
      'https://files.acct.r2.cloudflarestorage.com',
    ],
    [
      'an endpoint with a trailing slash',
      { ...s3, S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/' },
      'https://files.acct.r2.cloudflarestorage.com',
    ],
    [
      "MinIO: path style, the endpoint and the bucket's path",
      { ...s3, S3_ENDPOINT: 'http://minio:9000', S3_FORCE_PATH_STYLE: 'on' },
      'http://minio:9000/files/',
    ],
    [
      'an IPv4 host: path style by itself',
      { ...s3, S3_ENDPOINT: 'http://10.0.0.5:9000' },
      'http://10.0.0.5:9000/files/',
    ],
    [
      'an IPv6 host: path style by itself',
      { ...s3, S3_ENDPOINT: 'http://[::1]:9000' },
      'http://[::1]:9000/files/',
    ],
    [
      'a name that is not a DNS label (a dot, over https): path style',
      { ...s3, S3_BUCKET: 'my.files', S3_REGION: 'eu-west-1' },
      'https://s3.eu-west-1.amazonaws.com/my.files/',
    ],
    [
      'a name with a capital: path style',
      { ...s3, S3_BUCKET: 'Files', S3_REGION: 'eu-west-1' },
      'https://s3.eu-west-1.amazonaws.com/Files/',
    ],
    [
      'a dotted name over http: still a label',
      { ...s3, S3_BUCKET: 'my.files', S3_ENDPOINT: 'http://store.test:9000' },
      'http://my.files.store.test:9000',
    ],
    [
      'S3_FORCE_PATH_STYLE=on with AWS: the shared host, scoped to the bucket',
      { ...s3, S3_REGION: 'eu-west-1', S3_FORCE_PATH_STYLE: 'on' },
      'https://s3.eu-west-1.amazonaws.com/files/',
    ],
    [
      'S3_FORCE_PATH_STYLE=off',
      { ...s3, S3_REGION: 'eu-west-1', S3_FORCE_PATH_STYLE: 'off' },
      'https://files.s3.eu-west-1.amazonaws.com',
    ],
  ];
  for (const [name, env, origin] of cases) {
    it(`names the bucket's origin: ${name}`, () => {
      const { value, warning } = derive(env);
      assert.equal(value, origin);
      assert.equal(warning, '');
    });
  }

  it('leaves the bucket out, with a warning, when no origin can be made of the settings', () => {
    for (const env of [
      { ...s3 }, // no region, no endpoint
      { ...s3, S3_ENDPOINT: 'store.test' }, // no scheme
      { ...s3, S3_ENDPOINT: 'ftp://store.test' },
      { ...s3, S3_ENDPOINT: "https://store.test; script-src 'unsafe-inline'" }, // would end the directive
      { ...s3, S3_BUCKET: "files'", S3_REGION: 'eu-west-1' },
      { ...s3, S3_BUCKET: 'fi:les[1]', S3_REGION: 'eu-west-1' }, // a host's characters, not a bucket's
    ]) {
      const { value, warning } = derive(env);
      assert.equal(value, '', JSON.stringify(env));
      assert.match(warning, /no bucket origin/, JSON.stringify(env));
    }
  });
});

describe('the entrypoint checks FILES_ORIGIN', () => {
  const run = (FILES_ORIGIN) =>
    filesOrigins(FILES_ORIGIN === undefined ? {} : { FILES_ORIGIN });

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
        `${JSON.stringify(value)}: ${result.warning}`,
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
      assert.match(result.warning, /FILES_ORIGIN: .* is not an https origin/);
    }
  });

  it("adds its origins after the bucket's, each once, spaces trimmed", () => {
    assert.equal(run(`  ${cdn}  `).value, cdn);
    assert.equal(
      filesOrigins({
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'files',
        S3_REGION: 'eu-west-1',
        FILES_ORIGIN: `${cdn} ${bucket} ${cdn}`,
      }).value,
      `${bucket} ${cdn}`,
    );
  });

  it('never takes WEB_FILES_ORIGINS from the environment', () => {
    assert.equal(
      filesOrigins({ WEB_FILES_ORIGINS: "'unsafe-inline'" }).value,
      '',
    );
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

describe("the image's precompression (apps/web/scripts/precompress.mjs)", () => {
  it('writes a .br and a .gz beside each text or WebAssembly file they make smaller, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'precompress-test-'));
    try {
      const wasm = Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        Buffer.alloc(4096),
      ]);
      const files = {
        'app.js': Buffer.from(APP_JS),
        'app.css': Buffer.from('.compressible { color: red; }\n'.repeat(40)),
        'engine.wasm': wasm,
        // Under the size where compressing saves anything: left alone.
        'tiny.js': Buffer.from('export{};'),
        // Compressed already.
        'font.woff2': Buffer.from(APP_JS),
        'icon.png': Buffer.from(APP_JS),
      };
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
      }
      precompress(dir);
      const written = readdirSync(dir)
        .filter((name) => !(name in files))
        .toSorted();
      assert.deepEqual(written, [
        'app.css.br',
        'app.css.gz',
        'app.js.br',
        'app.js.gz',
        'engine.wasm.br',
        'engine.wasm.gz',
      ]);
      for (const name of ['app.js', 'app.css', 'engine.wasm']) {
        const read = (suffix) => readFileSync(join(dir, name + suffix));
        assert.deepEqual(brotliDecompressSync(read('.br')), files[name], name);
        assert.deepEqual(gunzipSync(read('.gz')), files[name], name);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A Caddyfile as a tree of its directives: each line (comments, blank lines
 * and the brace that opens a block left out) with the block it opens. The
 * placeholders of the origins of files (the Caddyfile's {env.*}, the chart's
 * template) are left out of a line, and its spaces normalised: what is left
 * is what both files must say alike.
 */
function directives(text) {
  const root = { line: '', block: [] };
  const open = [root];
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      .replaceAll('{env.WEB_FILES_ORIGINS}', '')
      .replaceAll('{{ with $filesOrigins }} {{ . }}{{ end }}', '')
      .replace(/\s+/g, ' ')
      .replaceAll(' ;', ';');
    if (line === '' || line.startsWith('#')) continue;
    if (line === '}') {
      open.pop();
      continue;
    }
    const node = { line: line.replace(/\s*\{$/, ''), block: [] };
    open.at(-1).block.push(node);
    if (line.endsWith('{')) open.push(node);
  }
  assert.equal(open.length, 1, 'every block is closed');
  return root.block;
}

/** The directive of `block` whose line is `line`, or that matches it. */
function directive(block, line) {
  const found = block.filter((node) =>
    typeof line === 'string' ? node.line === line : line.test(node.line),
  );
  assert.equal(found.length, 1, `one ${line} in the block`);
  return found[0];
}

describe("the Helm chart's web Caddy (deploy/helm/app/templates/web-configmap.yaml)", () => {
  const configMap = readFileSync(
    new URL('../deploy/helm/app/templates/web-configmap.yaml', import.meta.url),
    'utf8',
  );
  // The ConfigMap's `Caddyfile: |` block, as Caddy reads it.
  const chartCaddyfile = /^ {2}Caddyfile: \|\n((?: {4}.*\n|\n)+)/m
    .exec(configMap)?.[1]
    .replace(/^ {4}/gm, '');
  // The web app's half of each: the Caddyfile's web `handle` (the one with
  // the root), the chart's only site.
  const web = directive(
    directive(directives(caddyfile), '{$APP_DOMAIN}').block,
    'handle',
  ).block;
  const chart = directive(directives(chartCaddyfile ?? ''), ':8080').block;

  it("is the Caddyfile's web app: the root, the headers, the compression and the handles", () => {
    assert.ok(chartCaddyfile, 'the ConfigMap has a Caddyfile');
    for (const line of [
      'root * /srv/web',
      'header',
      'encode zstd gzip',
      'handle /version.json',
      'handle /assets/*',
      'handle',
    ]) {
      assert.deepEqual(directive(chart, line), directive(web, line), line);
    }
    // And nothing else, but what each has of its own: the maintenance page
    // (Compose's MAINTENANCE_PAGE), the pod's health check.
    const lines = (block) => block.map((node) => node.line);
    assert.deepEqual(
      lines(web).filter((line) => !lines(chart).includes(line)),
      [
        '@maintenance expression {env.MAINTENANCE_PAGE} == "on"',
        'handle @maintenance',
      ],
    );
    assert.deepEqual(
      lines(chart).filter((line) => !lines(web).includes(line)),
      ['handle /healthz'],
    );
  });

  it('sends the whole set of security headers', () => {
    const names = directive(web, 'header').block.map((node) =>
      /^([\w-]+) /.exec(node.line)?.[1].toLowerCase(),
    );
    assert.deepEqual(
      names.toSorted(),
      ['content-security-policy', ...Object.keys(WEB_HEADERS)].toSorted(),
    );
  });
});
