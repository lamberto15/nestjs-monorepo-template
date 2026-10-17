import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  AUTHENTICATION_MODULE_OPTIONS,
  AuthenticationRegistry,
  type AuthenticationModuleOptions,
  JwtBearerProvider,
  type JwtClaims,
  JwtSigner,
} from '@nestjs/authentication';
import { eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { io } from 'socket.io-client';
import { inTransaction } from '../src/core/database/transactions.js';
import { SystemContext } from '../src/iam/access/system-context.js';
import { AuditRetentionJob } from '../src/iam/audit/audit-retention.job.js';
import type { Principal } from '../src/iam/auth/principal.js';
import { JwtAuth } from '../src/iam/auth/jwt-auth.provider.js';
import { UsersRepository } from '../src/iam/auth/users.repository.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import { notifications } from '../src/platform/notifications/notifications.tables.js';
import { ACCOUNT_DELETION_JOB } from '../src/platform/platform.jobs.js';
import { bootApp, type TestApp } from './support.js';

/** An access token signed with the app's own key, saying whatever `claims` say. */
const tokenFor = (node: TestApp, claims: JwtClaims) =>
  new JwtSigner(
    node.app.get<AuthenticationModuleOptions>(AUTHENTICATION_MODULE_OPTIONS)
      .accessToken!,
  ).sign(claims);

/** Whether a socket.io handshake with this token is let in. */
async function handshake(node: TestApp, token: string) {
  const { port } = node.app.getHttpServer().address() as AddressInfo;
  const socket = io(`http://127.0.0.1:${port}/realtime`, {
    auth: { token },
    transports: ['websocket'],
  });
  try {
    return await new Promise<string>((resolve) => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', (error) => resolve(error.message));
    });
  } finally {
    socket.disconnect();
  }
}

describe('the system principal', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it("is a cron job's audit actor, named after the job", async () => {
    const db = node.db;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await db.insert(auditLog).values({
      tenantId: node.tenantId,
      actor: 'user:00000000-0000-7000-8000-000000000000',
      actorLabel: 'someone@example.com',
      action: 'test-item.created',
      at: old,
    });

    expect(await node.app.get(AuditRetentionJob).run()).toBe(1);

    const pruned = await node
      .admin()
      .get('/v1/access/audit?action=audit.pruned')
      .expect(200);
    expect(pruned.body.items).toHaveLength(1);
    expect(pruned.body.items[0]).toMatchObject({
      actor: 'system:audit-retention',
      actorLabel: 'System: Audit retention',
      details: { deleted: 1 },
    });
    // The audit log filters by it like any actor.
    const byActor = await node
      .admin()
      .get('/v1/access/audit?actor=system:audit-retention')
      .expect(200);
    expect(byActor.body.items.map((e: { action: string }) => e.action)).toEqual(
      ['audit.pruned'],
    );
    const [gone] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'test-item.created'));
    expect(gone).toBeUndefined();
  });

  it('is the first-boot seed’s actor', async () => {
    const seeded = await node
      .admin()
      .get('/v1/access/audit?action=user.seeded')
      .expect(200);
    expect(seeded.body.items[0]).toMatchObject({
      actor: 'system:seed',
      actorLabel: 'System: First-boot seed',
    });
  });

  it('lists the system jobs and what each may do in the catalog', async () => {
    const catalog = await node.admin().get('/v1/access/catalog').expect(200);
    const jobs = catalog.body.systemJobs as {
      key: string;
      actor: string;
      permissions: { subject: string; action: string }[];
    }[];
    expect(jobs.map((job) => job.key)).toEqual(
      expect.arrayContaining([
        'seed',
        'audit-retention',
        'account-deletion',
        'report-runner',
        'approvals',
      ]),
    );
    // Least privilege: a job that checks no permission declares none.
    expect(jobs.find((job) => job.key === 'account-deletion')).toMatchObject({
      actor: 'system:account-deletion',
      permissions: [],
    });
    // Nothing implicit: no job holds all.manage.
    expect(
      jobs.flatMap((job) => job.permissions).some((p) => p.subject === 'all'),
    ).toBe(false);
  });

  it('gets no notification: notify() drops system: recipients', async () => {
    const editor = await node.user(['editor']);
    const service = node.app.get(NotificationsService);
    const txHost = node.app.get(TransactionHost);
    const data = { via: 'change' as const, ip: '127.0.0.1' };
    const ids = await inTransaction(txHost, (tx) =>
      service.notify(tx, {
        type: 'security.passwordChanged',
        to: ['system:approvals', `user:${editor.id}`, 'system:seed'],
        data,
      }),
    );
    expect(ids).toHaveLength(1);
    expect(
      await inTransaction(txHost, (tx) =>
        service.notify(tx, {
          type: 'security.passwordChanged',
          to: 'system:seed',
          data,
        }),
      ),
    ).toEqual([]);
    const db = node.db;
    expect(
      (await db.select({ to: notifications.recipient }).from(notifications))
        .map((row) => row.to)
        .filter((to) => to.startsWith('system:')),
    ).toEqual([]);
  });

  it('cannot be claimed with a token: a forged subject is no one', async () => {
    for (const sub of [
      'system:account-deletion',
      'account-deletion',
      'system',
    ]) {
      const token = tokenFor(node, { sub });
      const refused = await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(refused.body.status).toBe(401);
      expect(await handshake(node, token)).toBe('unauthorized');
    }
    // An API key naming it is no key either.
    await node
      .http()
      .get('/v1/test-items')
      .set('Authorization', 'Bearer sk_system_account-deletion')
      .expect(401);
  });
});

/**
 * A credential provider that, by mistake, hands out the system principal
 * (a token whose subject is `system`): the guard still refuses it, over
 * HTTP and at the realtime handshake.
 */
@Injectable()
class LeakyJwtAuth extends JwtBearerProvider<Principal> {
  constructor(
    @Inject(UsersRepository) private readonly accounts: UsersRepository,
    @Inject(SystemContext) private readonly system: SystemContext,
    @Inject(AuthenticationRegistry) registry: AuthenticationRegistry,
  ) {
    super({ realm: 'api' });
    registry.registerProvider(this, { order: 2 });
  }

  validate({ sub, tid }: JwtClaims) {
    if (sub === 'system') {
      return this.system.principal(ACCOUNT_DELETION_JOB);
    }
    return sub ? this.accounts.inTenant(sub, tid as string | undefined) : null;
  }
}

describe('a credential provider returning the system principal', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(JwtAuth).useClass(LeakyJwtAuth),
    );
  });

  afterEach(async () => {
    await node.close();
  });

  it('is refused: the system never authenticates a request', async () => {
    const token = tokenFor(node, { sub: 'system' });
    const refused = await node
      .http()
      .get('/v1/test-items')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(refused.body.code).toBe('system_principal_refused');
    // Routes any principal may call too.
    await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(await handshake(node, token)).toBe('unauthorized');
    // The same provider still signs users in.
    const me = await node.admin().get('/v1/auth/me').expect(200);
    const user = tokenFor(node, {
      sub: me.body.user.id,
      tid: me.body.user.tenantId,
    });
    await node
      .http()
      .get('/v1/test-items')
      .set('Authorization', `Bearer ${user}`)
      .expect(200);
  });
});
