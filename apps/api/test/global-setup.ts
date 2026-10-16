import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { migrateAll } from '../src/core/database/migrate-all.js';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
    /** A PostgreSQL server the tests may create databases on (its `postgres` database). */
    postgresUrl: string;
    /**
     * The same server as the run's owner role (owns the tables, ran the
     * migrations) and as its app role (what every app under test connects
     * as: no superuser, no RLS bypass, owns nothing), both made for the run.
     */
    ownerUrl: string;
    appUrl: string;
    /** The migrated database every test database is a copy of. */
    templateDatabase: string;
  }
}

/** A free TCP port on loopback. */
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * One Redis for the run: REDIS_URL when it's set (CI's service), otherwise a
 * throwaway `redis-server` on a free port, without persistence. Each test
 * file keeps to its own key prefix (setup-env.ts).
 */
async function startRedis(): Promise<{ url: string; stop?: () => void }> {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }
  const port = await freePort();
  const redis: ChildProcess = spawn(
    'redis-server',
    [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { stdio: 'ignore' },
  );
  await new Promise<void>((resolve, reject) => {
    redis.once('error', (error) =>
      reject(
        new Error(
          `redis-server could not start (install Redis, or set REDIS_URL): ${error.message}`,
        ),
      ),
    );
    redis.once('spawn', () => setTimeout(resolve, 300));
  });
  return { url: `redis://127.0.0.1:${port}`, stop: () => redis.kill() };
}

/** Waits until PostgreSQL at `url` accepts connections. */
async function ready(url: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('select 1');
      return;
    } catch (error) {
      if (Date.now() > until) {
        throw new Error(`PostgreSQL didn't start: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

/** The label of this suite's containers, to find the ones a killed run left. */
const CONTAINER_LABEL = 'nestjs-monorepo-template-tests';

/**
 * The throwaway container's superuser, its name and its password (no
 * secret: the server lives for one run, on loopback, and is removed).
 */
const CONTAINER_ADMIN = 'test';

/** `serverUrl`, connecting as `role` with `secret`. */
const asRole = (serverUrl: string, role: string, secret: string) => {
  const url = new URL(serverUrl);
  url.username = role;
  url.password = secret;
  return url.toString();
};

/**
 * Removes the containers of runs that never reached their teardown (the
 * process was killed, the terminal closed): those older than an hour, so a
 * run going on in another terminal keeps its own.
 */
function removeStaleContainers() {
  const ids = execFileSync(
    'docker',
    ['ps', '--quiet', '--filter', `label=${CONTAINER_LABEL}`],
    { stdio: 'pipe', encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  for (const id of ids) {
    const created = execFileSync(
      'docker',
      ['inspect', '--format', '{{.Created}}', id],
      { stdio: 'pipe', encoding: 'utf8' },
    ).trim();
    if (Date.now() - new Date(created).getTime() > 60 * 60 * 1000) {
      execFileSync('docker', ['rm', '--force', id], { stdio: 'pipe' });
    }
  }
}

/**
 * One PostgreSQL 18 for the run: TEST_DATABASE_URL when it's set (CI's
 * service; a superuser, as its POSTGRES_USER), otherwise a throwaway Docker
 * container: on tmpfs, tuned for speed (no fsync), reachable from loopback
 * only, removed with everything in it at the end of the run. Passwords are
 * checked (scram-sha-256, as CI's service and a deployment do), so the
 * verifiers the bootstrap computes (roles.ts) are proven at every connection
 * as the app role, and a rotated password can be tested.
 */
async function startPostgres(): Promise<{ url: string; stop?: () => void }> {
  if (process.env.TEST_DATABASE_URL) {
    return { url: process.env.TEST_DATABASE_URL };
  }
  const port = await freePort();
  const name = `template-tests-${randomUUID().slice(0, 8)}`;
  try {
    removeStaleContainers();
    execFileSync(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        name,
        '--label',
        CONTAINER_LABEL,
        '--env',
        `POSTGRES_USER=${CONTAINER_ADMIN}`,
        '--env',
        `POSTGRES_PASSWORD=${CONTAINER_ADMIN}`,
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        '--publish',
        `127.0.0.1:${port}:5432`,
        '--tmpfs',
        '/var/lib/postgresql',
        'postgres:18-alpine',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
        '-c',
        'max_connections=1000',
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(
      `Could not start PostgreSQL in Docker (start Docker, or set TEST_DATABASE_URL): ${String(error)}`,
    );
  }
  const url = asRole(
    `postgres://127.0.0.1:${port}/postgres`,
    CONTAINER_ADMIN,
    CONTAINER_ADMIN,
  );
  await ready(url);
  return {
    url,
    stop: () => {
      try {
        execFileSync('docker', ['rm', '--force', name], { stdio: 'pipe' });
      } catch {
        // Already gone.
      }
    },
  };
}

/** The URL of database `name` on the server of `serverUrl`. */
export const databaseUrl = (serverUrl: string, name: string) => {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

export default async function setup(project: TestProject) {
  const [redis, postgres] = await Promise.all([startRedis(), startPostgres()]);
  const suffix = randomUUID().slice(0, 8);
  // The run's roles, as a deployment has them (docs/deployment.md, "Database
  // roles"): an owner with CREATEROLE and no superuser rights, as a managed
  // PostgreSQL gives, so the bootstrap is proven to work without them, and
  // the app role `migrateAll()` makes from the app URL, which every app under
  // test connects as. The template is the owner's, migrated once (the app's
  // tables and the stores' schemas); each app of each test gets a copy of it
  // (support.ts testDatabase()), grants and ownership included.
  const template = `template_${suffix}`;
  const owner = `owner_${suffix}`;
  const app = `app_${suffix}`;
  const ownerSecret = randomBytes(12).toString('hex');
  const ownerUrl = asRole(postgres.url, owner, ownerSecret);
  const appUrl = asRole(postgres.url, app, randomBytes(12).toString('hex'));
  const onServer = async (statement: string) => {
    const admin = new Client({ connectionString: postgres.url });
    await admin.connect();
    try {
      await admin.query(statement);
    } finally {
      await admin.end();
    }
  };
  // Each test drops its copy (support.ts); the template and the roles go
  // here, so a server of your own (TEST_DATABASE_URL) is left as it was
  // found: also the copies of a test that never reached its close() (a
  // killed worker), which would keep the owner role from being dropped.
  const teardown = async () => {
    const leftovers = new Client({ connectionString: postgres.url });
    await leftovers.connect();
    try {
      const { rows } = await leftovers.query<{ datname: string }>(
        `select d.datname from pg_database d join pg_roles r on r.oid = d.datdba
         where r.rolname = $1 and d.datname <> $2`,
        [owner, template],
      );
      for (const { datname } of rows) {
        console.warn(`Dropping the test database ${datname} a test left`);
        await leftovers.query(`drop database "${datname}" with (force)`);
      }
    } catch (error) {
      console.warn(`Leftover test databases not checked: ${String(error)}`);
    } finally {
      await leftovers.end().catch(() => undefined);
    }
    await onServer(`drop database if exists "${template}" with (force)`).catch(
      (error) => console.warn(`Template not dropped: ${String(error)}`),
    );
    for (const role of [app, owner]) {
      try {
        await onServer(`drop role if exists "${role}"`);
      } catch (error) {
        console.warn(`Role ${role} not dropped: ${String(error)}`);
      }
    }
    postgres.stop?.();
    redis.stop?.();
  };
  try {
    await onServer(
      `create role "${owner}" login createrole nosuperuser nocreatedb nobypassrls password '${ownerSecret}'`,
    );
    await onServer(`create database "${template}" owner "${owner}"`);
    await migrateAll({
      ownerUrl: databaseUrl(ownerUrl, template),
      appUrl: databaseUrl(appUrl, template),
    });
  } catch (error) {
    // A failed bootstrap leaves no role, template or container behind.
    await teardown();
    throw error;
  }
  project.provide('redisUrl', redis.url);
  project.provide('postgresUrl', postgres.url);
  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', appUrl);
  project.provide('templateDatabase', template);
  return teardown;
}
