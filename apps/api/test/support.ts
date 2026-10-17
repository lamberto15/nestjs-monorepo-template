import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { BYPASS, TENANT_SCOPE } from '../src/core/tenancy/tenant-scope.js';
import { ClsServiceManager } from 'nestjs-cls';
import { inTenantOf } from '../src/core/tenancy/tenant-job.js';
import { tenants } from '../src/core/tenancy/tenancy.tables.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { and, desc, eq } from 'drizzle-orm';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import {
  type InMemoryMailTransport,
  MailTransport,
  type SentMailQuery,
} from '@nestjs/mail';
import { OutboxRelay } from '@nestjs/outbox';
import { WebhookWorker } from '@nestjs/webhooks';
import { signWebhook } from '@nestjs/webhooks/testing';
import {
  ManualWorkflowClock,
  WORKFLOWS_MODULE_OPTIONS,
  WorkflowClient,
  WorkflowWorker,
} from '@nestjs/workflows';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Client, Pool } from 'pg';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import type { Database } from '../src/core/database/drizzle.js';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createDatabase } from '../src/core/database/drizzle.js';
import { configureApp } from '../src/configure-app.js';
import { PASSWORD_HASHER_PARAMS } from '../src/iam/account/password-hashing.js';
import { databaseUrl } from './global-setup.js';

/** A TOTP code for a base32 secret, as an authenticator app computes it (RFC 6238). */
export function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** A password that passes the 12-character rule, made up per call. */
export const newPassword = () => randomBytes(12).toString('base64url');

/**
 * What the helpers' sign-ins (`bootApp`'s administrator, `signIn`, `user`)
 * send in `X-Captcha-Token`: a file that turns CAPTCHA_MODE on sets it to
 * a function making a fresh accepted token (a token is good once).
 */
export const testHooks: { captchaToken?: () => string } = {};

/**
 * Forgets what earlier apps of this file left in Redis (rate-limit counters,
 * queues): every app starts as on a fresh Redis.
 */
async function clearRedis() {
  const redis = new Redis(process.env.REDIS_URL!);
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${process.env.REDIS_PREFIX}:*`,
        'COUNT',
        500,
      );
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

/** Runs `statement` on the test server's `postgres` database (create and drop database). */
async function onServer(statement: string) {
  const admin = new Client({ connectionString: inject('postgresUrl') });
  await admin.connect();
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/**
 * A database of its own, copied from the run's migrated template (a copy
 * takes milliseconds), so every test starts from empty tables, connected as
 * the run's app role, as api and worker are: it owns nothing and may not
 * change the schema (`asOwner()` runs the statements that must). `close()`
 * ends its connections and drops it, so a run leaves nothing behind (a
 * suite's copies would otherwise fill the container's tmpfs, or pile up on
 * the server TEST_DATABASE_URL points at).
 */
export async function testDatabase() {
  const name = `test_${randomUUID().replace(/-/g, '')}`;
  const ownerRole = decodeURIComponent(new URL(inject('ownerUrl')).username);
  // FILE_COPY: a plain copy of the template's files, fast for small databases.
  // The owner's, as the template is: `public` belongs to the database's
  // owner (pg_database_owner), so the owner may add tables to the copy.
  await onServer(
    `create database "${name}" template "${inject('templateDatabase')}" owner "${ownerRole}" strategy file_copy`,
  );
  const url = databaseUrl(inject('appUrl'), name);
  const ownerUrl = databaseUrl(inject('ownerUrl'), name);
  const maintenanceUrl = databaseUrl(inject('maintenanceUrl'), name);
  const db = await createDatabase({
    url,
    // As a worker has it (APP_ROLE=all in the tests): the bypass's pool.
    maintenanceUrl,
    migrate: false,
    pool: {
      max: 10,
      timeoutMs: 30_000,
      statementTimeoutMs: 30_000,
      idleTxTimeoutMs: 60_000,
      applicationName: 'tests',
    },
  });
  const pool = (db as unknown as { $client: Pool }).$client;
  // The app watches the pool CoreModule made, not this one: a connection the
  // server drops would otherwise be an unhandled 'error' event, ending the worker.
  pool.on('error', (error) =>
    console.warn(`Test database ${name}: ${error.message}`),
  );
  return {
    db,
    url,
    ownerUrl,
    maintenanceUrl,
    /** Runs `statement` as the owner of the tables: a fixture table, a change to the schema. */
    asOwner: async (statement: string) => {
      const owner = new Client({ connectionString: ownerUrl });
      await owner.connect();
      try {
        await owner.query(statement);
      } finally {
        await owner.end();
      }
    },
    /** Ends the database's connections (already ended by the app, when one ran on it) and drops it. */
    close: async () => {
      await pool.end().catch(() => undefined);
      await onServer(`drop database "${name}" with (force)`);
    },
  };
}

/** Runs `work` across every tenant (the maintenance jobs' bypass), with no app booted. */
export function bypassingTenants<T>(work: () => Promise<T>): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  return cls.run({ ifNested: 'inherit' }, async () => {
    cls.set(TENANT_SCOPE, BYPASS);
    return await work();
  });
}

/** Runs a test's body in one tenant's scope: `it('…', scoped(async () => …))`. */
export type Scoped = <T>(work: () => Promise<T>) => () => Promise<T>;

/**
 * A tenant on a database of its own (`testDatabase()`, no app), for tests of
 * core helpers on tenant tables (the tree, countPage): `scoped()` runs work
 * in its scope (CLS), as a request of the tenant would; the tenant is made
 * by `create(db)` (in `beforeAll`), and read when a test runs.
 */
export function testTenant() {
  let tenantId: string | undefined;
  const scoped: Scoped = (work) => () =>
    inTenantOf({ tenantId: tenantId! }, work);
  return {
    scoped,
    create: async (db: Database) => {
      const [tenant] = await db
        .insert(tenants)
        .values({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Test' })
        .returning({ id: tenants.id });
      tenantId = tenant!.id;
    },
  };
}

/**
 * Boots the app as main.ts does, on a free port, with a manual workflow
 * clock, on a database of its own. `override` replaces more providers
 * (a test's own credential provider, say); `module` boots another root
 * that imports AppModule (the demo seed's, DemoSeedModule).
 */
export async function bootApp(
  clock = new ManualWorkflowClock(),
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (
    builder,
  ) => builder,
  { module = AppModule }: { module?: Type } = {},
) {
  await clearRedis();
  const database = await testDatabase();
  const builder = Test.createTestingModule({ imports: [module] })
    // Only the exported token can be overridden (the module's options token
    // isn't public), so CoreModule's factory still makes a pool on
    // DATABASE_URL (the server's `postgres` database) for every app. It never
    // connects: MIGRATE_ON_START is off in tests (setup-env.ts), and nothing
    // queries it; the module closes it with the app.
    .overrideProvider(getDrizzleToken())
    .useValue(database.db)
    .overrideProvider(WORKFLOWS_MODULE_OPTIONS)
    .useValue({ clock, worker: { enabled: false, shutdownTimeout: 50 } })
    // scrypt as production runs it (N = 2^17, 128 MiB) costs every hash and
    // sign-in a few hundred milliseconds, and every test boots an app that
    // seeds and signs in users: the package's cheaper parameters for tests
    // (its PasswordHasher docs). Same code path (the app's bounded hasher,
    // under PASSWORD_HASH_CONCURRENCY), a hash 128 times cheaper.
    .overrideProvider(PASSWORD_HASHER_PARAMS)
    .useValue({ logN: 10 });
  const moduleRef = await override(builder).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    // TEST_LOGS=1 shows the application's errors while debugging a test.
    logger: process.env.TEST_LOGS ? ['error', 'warn'] : false,
    rawBody: true,
  });
  await configureApp(app);
  await app.listen(0, '127.0.0.1');
  const http = () => request(app.getHttpServer());

  /** A browser signed in as this user: it keeps the session cookie. */
  const signIn = async (email: string, password: string) => {
    const agent = request.agent(app.getHttpServer());
    const req = agent.post('/v1/auth/sign-in');
    if (testHooks.captchaToken) {
      req.set('X-Captcha-Token', testHooks.captchaToken());
    }
    await req.send({ email, password }).expect(200);
    return agent;
  };
  const admin = await signIn(
    process.env.ADMIN_EMAIL!,
    process.env.ADMIN_PASSWORD!,
  );

  /** The ids of the seeded roles with these keys (`administrator`, `editor`, `viewer`). */
  const roleIds = async (...keys: string[]) => {
    const roles = (await admin.get('/v1/access/roles').expect(200)).body
      .items as {
      id: string;
      key: string | null;
    }[];
    return keys.map((key) => {
      if (/^[0-9a-f-]{36}$/.test(key)) {
        return key; // already an id
      }
      const role = roles.find((candidate) => candidate.key === key);
      if (!role) {
        throw new Error(`No seeded role "${key}"`);
      }
      return role.id;
    });
  };

  /** The first mail matching `query`, once the app sent it (mail leaves after the response). */
  const waitForMail = async (query: SentMailQuery) => {
    const mailbox = app.get(MailTransport) as InMemoryMailTransport;
    for (let tries = 0; tries < 100; tries++) {
      const found = mailbox.find(query);
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return mailbox.assertSent(query);
  };

  /** The invitations to a tenant mailed to `email` (docs/tenancy.md, "Invitations"), oldest first. */
  const invitationsTo = (email: string) =>
    (app.get(MailTransport) as InMemoryMailTransport).filter({
      to: email,
      subject: /invited you to/,
    });
  const tokenOf = (mail: { link: (match?: string) => URL }) =>
    mail.link('/accept-invitation').searchParams.get('token')!;

  /**
   * `by` (an administrator's agent) invites `body.email` to their tenant;
   * the link's token, once its mail left (mail leaves after the answer).
   */
  const invite = async (
    by: request.Agent,
    body: { email: string; roleIds?: string[]; name?: string },
  ) => {
    const before = invitationsTo(body.email).length;
    await by
      .post('/v1/access/users')
      .send({ roleIds: [], ...body })
      .expect(202);
    for (let tries = 0; tries < 100; tries++) {
      const sent = invitationsTo(body.email);
      if (sent.length > before) {
        return tokenOf(sent.at(-1)!);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No invitation reached ${body.email}`);
  };

  /** A new address accepts an invitation: it chooses its password. */
  const acceptAsNew = async (token: string, name?: string) => {
    const password = newPassword();
    await http()
      .post('/v1/auth/invitations/accept')
      .send({ token, password, ...(name && { name }) })
      .expect(200);
    return password;
  };

  /**
   * Proves a signed-up address (verify first: its password signs in only
   * after this): the verification link mailed to it, confirmed with the
   * password chosen at sign-up.
   */
  const verifySignUp = async (email: string, password: string) => {
    const mail = await waitForMail({
      to: email,
      subject: 'Confirm your email address',
    });
    await http()
      .post('/v1/auth/email/verify')
      .send({
        token: mail.link('/verify-email').searchParams.get('token'),
        password,
      })
      .expect(200);
  };

  /** A new address accepts the (first) invitation mailed to it: its password. */
  const acceptInvitation = async (email: string) =>
    acceptAsNew(
      tokenOf(await waitForMail({ to: email, subject: /invited you to/ })),
    );

  /**
   * Another tenant (docs/tenancy.md), made by the operators (the seeded
   * administrator, in the operator tenant) with its own administrator,
   * who accepted the invitation and is signed in (the session acts in it,
   * their only tenant). Its `user()` and `client()` are that tenant's.
   */
  const otherTenant = async (slug = `t-${randomUUID().slice(0, 8)}`) => {
    const email = `${slug}-admin@example.com`;
    const created = await admin
      .post('/v1/tenants')
      .send({ name: slug, slug, administratorEmail: email })
      .expect(201);
    const password = await acceptInvitation(email);
    const tenantAdmin = await signIn(email, password);
    const roles = (await tenantAdmin.get('/v1/access/roles').expect(200)).body
      .items as { id: string; key: string | null }[];
    return {
      id: created.body.id as string,
      slug,
      email,
      password,
      admin: tenantAdmin,
      /** A user of this tenant with these roles (by key), who accepted, signed in. */
      async user(roleKeys: string[]) {
        const address = `${randomUUID().slice(0, 8)}@example.com`;
        const token = await invite(tenantAdmin, {
          email: address,
          name: address,
          roleIds: roleKeys.map(
            (key) => roles.find((role) => role.key === key)!.id,
          ),
        });
        const userPassword = await acceptAsNew(token);
        const agent = await signIn(address, userPassword);
        const me = await agent.get('/v1/auth/me').expect(200);
        return {
          id: me.body.user.id as string,
          email: address,
          password: userPassword,
          agent,
        };
      },
      /** A new API client of this tenant: its id and `Authorization` header. */
      async client(name = `client-${randomUUID().slice(0, 8)}`) {
        const client = await tenantAdmin
          .post('/v1/access/clients')
          .send({ name })
          .expect(201);
        return {
          id: client.body.id as string,
          key: client.body.key as string,
          auth: `Bearer ${client.body.key}`,
        };
      },
    };
  };

  /**
   * A test's own view of the database, past row-level security: the
   * maintenance role (BYPASSRLS) on a pool of its own. Fixtures read and age
   * rows of any tenant through it; an insert into a tenant table names its
   * `tenantId`. Never the app's pool, which stays as production runs it.
   */
  const testPool = new Pool({
    connectionString: database.maintenanceUrl,
    max: 3,
  });
  const db = drizzleNodePg({ client: testPool, schema }) as unknown as Database;

  /**
   * Audit entries of every tenant and of none (an account's own, which no
   * tenant's `GET /v1/access/audit` shows: sign-ins, sign-ups, password
   * resets, account deletion), newest first.
   */
  const auditEntries = (filter: {
    action?: string;
    actor?: string;
    targetId?: string;
  }) =>
    db
      .select()
      .from(auditLog)
      .where(
        and(
          filter.action ? eq(auditLog.action, filter.action) : undefined,
          filter.actor ? eq(auditLog.actor, filter.actor) : undefined,
          filter.targetId ? eq(auditLog.targetId, filter.targetId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.at), desc(auditLog.id));

  /** The seeded tenant: the operators', the administrator's (docs/tenancy.md). */
  const tenantId = (await admin.get('/v1/auth/me').expect(200)).body.user
    .tenantId as string;

  /**
   * Runs `work` in a tenant's scope (the seeded one by default), as a
   * request of that tenant would: what a test's own queries on tenant
   * tables need (`database.db` is the app's pool, row-level security and
   * all: no tenant, no rows).
   */
  const inTenant = <T>(work: () => Promise<T>, tenant = tenantId) =>
    app.get(Tenancy).run(tenant, work);

  /** Runs `work` across every tenant (the bypass the maintenance jobs use): fixtures that age rows. */
  const acrossTenants = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(BYPASS, work);

  return {
    app,
    clock,
    http,
    signIn,
    acceptInvitation,
    verifySignUp,
    invite,
    acceptAsNew,
    otherTenant,
    tenantId,
    inTenant,
    acrossTenants,
    db,
    auditEntries,
    /** This app's database: its URL as the app role, and as the owner (raw connections). */
    database: { url: database.url, ownerUrl: database.ownerUrl },
    /** The seeded administrator, signed in. */
    admin: () => admin,
    workflows: app.get(WorkflowClient),
    worker: app.get(WorkflowWorker),

    roleIds,

    /**
     * A user with these roles (by key, `editor`, or by id), invited by the
     * seeded administrator, who accepted (their own password) and is
     * signed in.
     */
    async user(roleKeys: string[]) {
      const email = `${randomUUID().slice(0, 8)}@example.com`;
      const token = await invite(admin, {
        email,
        name: email,
        roleIds: await roleIds(...roleKeys),
      });
      const password = await acceptAsNew(token);
      const agent = await signIn(email, password);
      const me = await agent.get('/v1/auth/me').expect(200);
      return { id: me.body.user.id as string, email, password, agent };
    },

    /** A new API client: its id and `Authorization` header. */
    async client(name = `client-${randomUUID().slice(0, 8)}`) {
      const created = await admin
        .post('/v1/access/clients')
        .send({ name })
        .expect(201);
      return {
        id: created.body.id as string,
        key: created.body.key as string,
        auth: `Bearer ${created.body.key}`,
      };
    },

    /** Writes a note as this API client (or users agent). */
    writeNote(
      auth: string | request.Agent,
      body: Record<string, unknown> = { title: 'Hello', body: 'World' },
      key: string = randomUUID(),
    ) {
      const req =
        typeof auth === 'string'
          ? http().post('/v1/notes').set('Authorization', auth)
          : auth.post('/v1/notes');
      return req.set('Idempotency-Key', key).send(body);
    },

    /** Hands committed outbox messages to the fan-out, then delivers what is due. */
    async deliverWebhooks() {
      await app.get(OutboxRelay).runOnce();
      return app.get(WebhookWorker).runOnce();
    },

    /** POSTs an event signed as the example sender signs it (Standard Webhooks). */
    exampleSender(
      payload: unknown,
      {
        id = `msg_${randomUUID()}`,
        secret = process.env.EXAMPLE_SENDER_WEBHOOK_SECRET!,
      } = {},
    ) {
      const signed = signWebhook({ scheme: 'standard', secret, payload, id });
      return http()
        .post('/v1/webhooks/example-sender')
        .set(signed.headers)
        .send(signed.body);
    },

    /** The mail the app sent (MAIL_TRANSPORT=memory). */
    mailbox: app.get(MailTransport) as InMemoryMailTransport,

    waitForMail,

    close: async () => {
      await testPool.end().catch(() => undefined);
      await app.close();
      await database.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof bootApp>>;

/** A socket.io connection to /realtime, authenticated with an API key (or a user token). */
export async function connect(node: TestApp, key: string): Promise<Socket> {
  const { port } = node.app.getHttpServer().address() as AddressInfo;
  const socket: Socket = io(`http://127.0.0.1:${port}/realtime`, {
    auth: { token: key },
    transports: ['websocket'],
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: { type: string; data: Record<string, unknown> };
}

/** An HTTP server on loopback that records the webhooks it receives (WEBHOOKS_ALLOW_LOOPBACK=on). */
export async function webhookReceiver() {
  const received: ReceivedWebhook[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
