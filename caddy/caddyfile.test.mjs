// The Caddyfile's behaviour, run by a real Caddy:
//   CADDY_BIN=/path/to/caddy node --test caddy/caddyfile.test.mjs
// (CI's caddy-image job takes the binary out of the image it built; without a
// binary the tests are skipped.) The real Caddyfile is used with four edits
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
const entrypoint = fileURLToPath(new URL('./entrypoint.sh', import.meta.url));
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

  it('connects to this origin only, and takes images from it and data: URLs', async () => {
    const response = await get(caddy, '/');
    assert.deepEqual(connectSources(response), ["'self'"]);
    assert.deepEqual(imgSources(response), ["'self'", 'data:']);
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
          ["'self'", 'data:', bucket],
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
      img: ["'self'", 'data:', bucket],
    });
  });

  it("adds FILES_ORIGIN after the bucket's origin, in both", async () => {
    assert.deepEqual(await policyWith({ ...s3, FILES_ORIGIN: cdn }), {
      connect: ["'self'", bucket, cdn],
      img: ["'self'", 'data:', bucket, cdn],
    });
  });

  it("scopes a path-style bucket to its path in both, not the shared host's every bucket", async () => {
    const pathStyle = 'https://s3.eu-west-1.amazonaws.com/my.files/';
    assert.deepEqual(await policyWith({ ...s3, S3_BUCKET: 'my.files' }), {
      connect: ["'self'", pathStyle],
      img: ["'self'", 'data:', pathStyle],
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
      { connect: ["'self'"], img: ["'self'", 'data:'] },
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
