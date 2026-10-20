// The API the browser tests run against (playwright.config.ts, `webServer`):
// the demo seed first, then the built API (`node dist/main`).
//
// The seed (docs/development.md, "Demo data") makes the demo tenant's members
// in the seed roles and prints their generated passwords once. They are kept
// in playwright/.auth/credentials.json (ignored by git) for the sign-in setup
// (test/auth.setup.ts). A database seeded before prints none: the file from
// that run stays, or E2E_CREDENTIALS points at another.
//
// The environment is what `pnpm services:up` (the development services) and
// apps/api/env.development.example give, each variable overridable from the
// shell: CI sets its own services' URLs (.github/workflows/web-e2e.yml). The
// seed refuses a database that isn't marked as a development one.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = resolve(here, '../../api');
const credentialsFile = resolve(
  here,
  '..',
  process.env.E2E_CREDENTIALS ?? 'playwright/.auth/credentials.json',
);
const webUrl = process.env.E2E_BASE_URL ?? 'http://localhost:4173';

const env = {
  NODE_ENV: 'development',
  // Not 3000 (nor 3100, Gotenberg's): a development stack (pnpm dev) may be running on this machine.
  PORT: '3300',
  DATABASE_URL: 'postgres://app_runtime:app_runtime@127.0.0.1:5432/app',
  DATABASE_OWNER_URL: 'postgres://app:app@127.0.0.1:5432/app',
  DATABASE_MAINTENANCE_URL:
    'postgres://app_maintenance:app_maintenance@127.0.0.1:5432/app',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MIGRATE_ON_START: 'on',
  // The web app and the API share one origin (vite preview proxies /v1), so
  // the __Host-sid cookie works; plain http://localhost accepts Secure cookies.
  APP_URL: webUrl,
  WEB_URL: webUrl,
  CORS_ORIGINS: webUrl,
  SESSION_COOKIE_SECURE: 'on',
  AUTH_SIGN_UP: 'on',
  // No outside services: mail to the log, files on disk, no PDFs.
  MAIL_TRANSPORT: 'log',
  STORAGE_DRIVER: 'local',
  PASSWORD_BREACH_CHECK: 'off',
  // SSO connections, devices and phone numbers are encrypted columns, the
  // last two with blind indexes (docs/encryption.md): their keys are required
  // at boot, made per run.
  DATA_ENCRYPTION_KEYS: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEYS: randomBytes(32).toString('base64'),
  // The suite signs in a few times per account on a database that may be reused.
  RATE_LIMIT_MULTIPLIER: '20',
  LOG_LEVEL: 'error',
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ),
};

function seed() {
  const result = spawnSync('node', ['dist/seed-demo.js'], {
    cwd: api,
    env,
    encoding: 'utf8',
  });
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  // "  <email>  <password>  <name> (<roles>)", the lines of report() in
  // apps/api/src/demo/run-demo-seed.ts.
  const accounts = [
    ...result.stdout.matchAll(/^ +(\S+@\S+) +(\S+) +.+ \(([^)]+)\)$/gm),
  ].map(([, email, password, roles]) => ({
    email,
    password,
    roles: roles.split(', '),
  }));
  if (accounts.length === 0) {
    console.log(
      `The demo data was seeded before: keeping ${credentialsFile} (or set E2E_CREDENTIALS).`,
    );
    return;
  }
  mkdirSync(dirname(credentialsFile), { recursive: true });
  writeFileSync(credentialsFile, JSON.stringify(accounts, null, 2), {
    mode: 0o600,
  });
  console.log(`Demo data seeded: ${accounts.length} accounts.`);
}

seed();
const server = spawn('node', ['dist/main.js'], {
  cwd: api,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => process.exit(code ?? 0));
