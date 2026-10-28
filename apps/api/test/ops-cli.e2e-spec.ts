import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { OpsError, OpsService, type Plan } from '../src/cli/ops.service.js';
import { inTransaction } from '../src/core/database/transactions.js';
import type { NotificationType } from '../src/platform/notifications/notification.types.js';
import { notifications } from '../src/platform/notifications/notifications.tables.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import { mfaFailures, mfaAuthenticators } from '../src/iam/iam.tables.js';
import { mailSuppressions } from '../src/platform/deliverability/deliverability.tables.js';
import {
  platformSettingValues,
  settingOverrides,
} from '../src/platform/settings/settings.tables.js';
import { TestAppModule } from './fixtures/test-app.module.js';
import { bootApp, connect, totp, type TestApp } from './support.js';

/** The app with the operator CLI's logic (the commands add only the prompt and the printing: ops.commands.spec.ts). */
@Module({ imports: [TestAppModule], providers: [OpsService] })
class OpsTestModule {}

/**
 * The operator CLI (src/cli, docs/deployment.md, "Operator CLI"): each
 * command is a plan (what it will do) and its application, over the app's
 * own services, as `system:ops`, with the operator's OS user and host in the
 * audit entry. The one-time passwords are returned to the caller (the
 * command prints them) and are in no audit entry.
 */
describe('operator CLI (e2e)', () => {
  let node: TestApp;
  let ops: OpsService;
  let db: Database;
  const operator = { user: 'alice', host: 'server-1' };

  beforeEach(async () => {
    node = await bootApp(undefined, undefined, { module: OpsTestModule });
    ops = node.app.get(OpsService);
    db = node.app.get<Database>(getDrizzleToken());
  });
  afterEach(() => node.close());

  /** Plans, then applies, as the command does after the operator confirms. */
  const run = async <T>(planning: Promise<Plan<T>>) =>
    (await planning).apply(operator);

  const signInStatus = (email: string, password: string) =>
    node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email, password })
      .then((res) => res.status);

  /** The audit entries `system:ops` wrote, whichever tenant (or none). */
  const written = (action: string) =>
    node.auditEntries({ action, actor: 'system:ops' });

  async function withMfa() {
    const account = await node.user([]);
    const { secret } = (
      await account.agent.post('/v1/auth/mfa/enroll').expect(200)
    ).body as { secret: string };
    await account.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(secret) })
      .expect(200);
    return account;
  }

  describe('tenant:list and user:list', () => {
    it('lists the tenants, and a tenant by slug or id with roles and two-factor', async () => {
      const other = await node.otherTenant();
      const list = await ops.tenantList();
      expect(list.map((tenant) => tenant.slug)).toContain(other.slug);
      expect(list.find((tenant) => tenant.id === other.id)).toMatchObject({
        active: true,
        members: 1,
      });

      const bySlug = await ops.userList(other.slug);
      const byId = await ops.userList(other.id);
      expect(byId.members).toEqual(bySlug.members);
      expect(bySlug.members).toEqual([
        expect.objectContaining({
          email: other.email,
          roles: ['administrator'],
          mfa: false,
        }),
      ]);
    });

    it('refuses an unknown tenant', async () => {
      await expect(ops.userList('nowhere')).rejects.toBeInstanceOf(OpsError);
    });
  });

  describe('admin:create', () => {
    it('makes a new administrator with a one-time password that signs in, audited as system:ops with the operator', async () => {
      const other = await node.otherTenant();
      const email = 'rescue@example.com';
      const plan = await ops.adminCreate(email, {
        tenant: other.slug,
        name: 'Rescue',
      });
      expect(plan.summary.join(' ')).toMatch(/Create the account/);
      // Planning writes nothing.
      expect(await signInStatus(email, 'whatever')).not.toBe(200);

      const result = await plan.apply(operator);
      expect(result).toMatchObject({ created: true, changed: true });
      const password = result.password!.password;
      expect(password.length).toBeGreaterThanOrEqual(24);

      const agent = await node.signIn(email, password);
      await agent.get('/v1/access/roles').expect(200);
      const me = await agent.get('/v1/auth/me').expect(200);
      expect(me.body.tenant.slug).toBe(other.slug);

      const [entry] = await written('ops.admin-created');
      expect(entry).toMatchObject({
        actor: 'system:ops',
        actorLabel: 'System: Operator CLI',
        targetType: 'user',
        details: { email, newAccount: true, via: 'cli', operator },
      });
      // Visible in the tenant's own log.
      const audit = await other.admin.get('/v1/access/audit').expect(200);
      expect(
        audit.body.items.map((item: { action: string }) => item.action),
      ).toContain('ops.admin-created');
      // The password is in no audit entry.
      expect(JSON.stringify(await node.auditEntries({}))).not.toContain(
        password,
      );
    });

    it('does nothing to an administrator already', async () => {
      const other = await node.otherTenant();
      const plan = await ops.adminCreate(other.email, { tenant: other.slug });
      expect(plan.summary.join(' ')).toMatch(/administrator of .* already/);
      expect(await plan.apply(operator)).toMatchObject({
        changed: false,
        created: false,
      });
      expect(await written('ops.admin-created')).toEqual([]);
    });

    it('makes an existing account an administrator and keeps its password', async () => {
      const other = await node.otherTenant();
      const user = await node.user(['editor']);
      const result = await run(
        ops.adminCreate(user.email, { tenant: other.slug }),
      );
      expect(result).toMatchObject({ created: false, changed: true });
      expect(result.password).toBeUndefined();
      expect(
        (await ops.userList(other.slug)).members.find(
          (member) => member.email === user.email,
        )?.roles,
      ).toEqual(['administrator']);
      expect(await signInStatus(user.email, user.password)).toBe(200);
    });

    it('needs --tenant where there are several tenants, and refuses a bad address or tenant', async () => {
      await node.otherTenant();
      await expect(ops.adminCreate('a@example.com')).rejects.toThrow(
        /several tenants/,
      );
      await expect(ops.adminCreate('not-an-address')).rejects.toBeInstanceOf(
        OpsError,
      );
      await expect(
        ops.adminCreate('a@example.com', { tenant: 'nowhere' }),
      ).rejects.toBeInstanceOf(OpsError);
    });
  });

  describe('user:reset-password', () => {
    it('sets a one-time password, ends every session, audits it, and tells nobody the password', async () => {
      const user = await node.user(['editor']);
      await user.agent.get('/v1/auth/me').expect(200);

      const result = await run(ops.resetPassword(user.email));
      expect(result.email).toBe(user.email);
      expect(result.password.length).toBeGreaterThanOrEqual(24);

      await user.agent.get('/v1/auth/me').expect(401);
      expect(await signInStatus(user.email, user.password)).not.toBe(200);
      expect(await signInStatus(user.email, result.password)).toBe(200);

      const [entry] = await written('ops.password-reset');
      expect(entry).toMatchObject({
        actor: 'system:ops',
        targetId: user.id,
        details: { via: 'cli', operator },
      });
      expect(JSON.stringify(await node.auditEntries({}))).not.toContain(
        result.password,
      );
    });

    it("ends the account's token clients' live connections too", async () => {
      const user = await node.user(['editor']);
      const { accessToken } = (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: user.email, password: user.password })
          .expect(200)
      ).body as { accessToken: string };
      const socket = await connect(node, accessToken);
      try {
        const ended = new Promise<string>((resolve) =>
          socket.once('disconnect', resolve),
        );
        await run(ops.resetPassword(user.email));
        expect(await ended).toBe('io server disconnect');
      } finally {
        socket.disconnect();
      }
    });

    it('refuses an address with no account', async () => {
      await expect(ops.resetPassword('ghost@example.com')).rejects.toThrow(
        /No account/,
      );
    });
  });

  describe('user:remove-mfa', () => {
    it('removes the authenticator and the recovery codes, so the password alone signs in', async () => {
      const user = await withMfa();
      const before = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(200);
      expect(before.body.mfaRequired).toBe(true);

      const plan = await ops.removeMfa(user.email);
      expect(plan.summary.join(' ')).toMatch(/Remove the authenticator/);
      expect(await plan.apply(operator)).toEqual({
        email: user.email,
        had: true,
      });

      const after = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(200);
      expect(after.body.mfaRequired).toBe(false);
      expect(
        await db
          .select()
          .from(mfaAuthenticators)
          .where(eq(mfaAuthenticators.userId, user.id)),
      ).toEqual([]);
      const [entry] = await written('ops.mfa-removed');
      expect(entry).toMatchObject({
        targetId: user.id,
        details: { via: 'cli', operator, had: true },
      });
    });

    it('says so for an account with none', async () => {
      const user = await node.user([]);
      const plan = await ops.removeMfa(user.email);
      expect(plan.summary.join(' ')).toMatch(/no authenticator/);
      expect(await plan.apply(operator)).toMatchObject({ had: false });
    });
  });

  describe('user:unlock', () => {
    it('clears the failed-code counter and the mail suppression, audited', async () => {
      const user = await node.user([]);
      await db.insert(mfaFailures).values([
        { userId: user.id, failedAt: new Date() },
        { userId: user.id, failedAt: new Date() },
      ]);
      await db.insert(mailSuppressions).values({
        address: user.email,
        reason: 'hard_bounce',
        source: 'ses',
        suppressedAt: new Date(),
      });

      const plan = await ops.unlock(user.email);
      expect(plan.summary.join(' ')).toMatch(/2 failed second-factor/);
      expect(await plan.apply(operator)).toEqual({
        email: user.email,
        failures: 2,
        suppressed: true,
      });

      expect(
        await db
          .select()
          .from(mfaFailures)
          .where(eq(mfaFailures.userId, user.id)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(mailSuppressions)
          .where(eq(mailSuppressions.address, user.email)),
      ).toEqual([]);
      const [entry] = await written('ops.user-unlocked');
      expect(entry).toMatchObject({
        details: { failuresCleared: 2, suppressionRemoved: true, operator },
      });
    });
  });

  describe('notifications:settle', () => {
    it("deletes a recipient's undelivered messages and marks their notifications delivered and read, never a mandatory type, audited", async () => {
      const user = await node.user([]);
      const other = await node.user([]);
      const service = node.app.get(NotificationsService);
      const txHost = node.app.get(TransactionHost);
      const tell = async (to: string, type: string, data: object) => {
        const [id] = await node.inTenant(() =>
          inTransaction(txHost, (tx) =>
            service.notify(tx, {
              type: type as NotificationType,
              to,
              data,
              key: randomUUID(),
            }),
          ),
        );
        return id!;
      };
      const comment = {
        recordId: randomUUID(),
        commentId: randomUUID(),
        title: 'Old',
        by: 'Ada',
        excerpt: 'Hi',
      };
      const old1 = await tell(`user:${user.id}`, 'testItem.commented', comment);
      const old2 = await tell(`user:${user.id}`, 'testItem.commented', comment);
      const secure = await tell(`user:${user.id}`, 'security.passwordChanged', {
        via: 'change',
        ip: '192.0.2.10',
      });
      const others = await tell(
        `user:${other.id}`,
        'testItem.commented',
        comment,
      );

      // As the CLI runs (cli.ts): APP_ROLE=api, no row-level security bypass.
      const role = process.env.APP_ROLE;
      process.env.APP_ROLE = 'api';
      try {
        const plan = await ops.settleNotifications(user.email, {});
        expect(plan.summary.join(' ')).toMatch(/Delete 2 undelivered/);
        expect(await plan.apply(operator)).toEqual({
          messages: 2,
          notifications: 2,
        });
      } finally {
        process.env.APP_ROLE = role;
      }

      const state = async (id: string) =>
        (
          await node.db
            .select()
            .from(notifications)
            .where(eq(notifications.id, id))
        )[0]!;
      for (const id of [old1, old2]) {
        expect(await state(id)).toMatchObject({
          deliveredAt: expect.any(Date),
          readAt: expect.any(Date),
        });
      }
      expect(await state(secure)).toMatchObject({
        deliveredAt: null,
        readAt: null,
      });
      expect(await state(others)).toMatchObject({ deliveredAt: null });
      // The test pool: notifications are under the tenants' row-level security.
      const left = await node.db
        .select({ id: sql<string>`payload->>'notificationId'` })
        .from(sql`nest_outbox.messages`)
        .where(sql`topic = 'notifications.deliver'`);
      expect(left.map((message) => message.id)).toEqual(
        expect.arrayContaining([secure, others]),
      );
      expect(left).toHaveLength(2);
      const [entry] = await written('ops.notifications-settled');
      expect(entry).toMatchObject({
        targetId: user.id,
        details: { messages: 2, notifications: 2, before: null, operator },
      });
    });
  });

  describe('setting:delete', () => {
    const KEY = 'auth.passwordMinLength';

    it("removes a tenant's value, audited with the settings' own entry", async () => {
      const other = await node.otherTenant();
      await other.admin
        .put(`/v1/settings/${KEY}`)
        .send({ value: 20 })
        .expect(200);

      const plan = await ops.deleteSetting(KEY, { tenant: other.slug });
      expect(plan.summary.join(' ')).toMatch(
        /Delete the value of .* \(now 20\)/,
      );
      expect(await plan.apply(operator)).toEqual({ removed: true });

      expect(
        await node.inTenant(
          () =>
            db
              .select()
              .from(settingOverrides)
              .where(eq(settingOverrides.key, KEY)),
          other.id,
        ),
      ).toEqual([]);
      expect((await written('setting.reset')).length).toBe(1);
      const [entry] = await written('ops.setting-deleted');
      expect(entry).toMatchObject({
        targetId: KEY,
        details: { scope: 'tenant', tenant: other.slug, operator },
      });
      // Nothing left to delete.
      expect(await run(ops.deleteSetting(KEY, { tenant: other.slug }))).toEqual(
        { removed: false },
      );
    });

    it("removes the platform's value", async () => {
      await node
        .admin()
        .put(`/v1/settings/${KEY}/platform`)
        .send({ value: 20 })
        .expect(200);
      expect(await run(ops.deleteSetting(KEY, { platform: true }))).toEqual({
        removed: true,
      });
      expect(
        await db
          .select()
          .from(platformSettingValues)
          .where(eq(platformSettingValues.key, KEY)),
      ).toEqual([]);
    });

    it('wants exactly one of --tenant and --platform', async () => {
      await expect(ops.deleteSetting(KEY, {})).rejects.toBeInstanceOf(OpsError);
      await expect(
        ops.deleteSetting(KEY, { tenant: 'x', platform: true }),
      ).rejects.toBeInstanceOf(OpsError);
    });
  });
});
