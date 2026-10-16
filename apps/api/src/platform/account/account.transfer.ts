import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lt as lessThan,
} from 'drizzle-orm';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants as tenants_ } from '../../core/tenancy/tenancy.tables.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import {
  auditLog,
  memberships,
  orgUnits,
  refreshTokens,
  roles,
  sessions,
  userIdentities,
  userOrgUnits,
  userRoles,
  users,
} from '../../iam/iam.tables.js';
import { DataTransferRegistry } from '../data-transfer/data-transfer.registry.js';
import type {
  DataExporter,
  TransferColumn,
} from '../data-transfer/data-transfer.types.js';
import {
  notificationPreferences,
  notifications,
} from '../notifications/notifications.tables.js';
import { settingOverrides } from '../settings/settings.tables.js';
import { recordSubscriptions } from '../subscriptions/subscriptions.tables.js';
import { consents } from './account.tables.js';
import { PersonalDataRegistry } from './personal-data.registry.js';

/** One record of the export: what kind, its id, and all of it. */
interface PersonalRow extends Record<string, unknown> {
  kind: string;
  id: string | null;
  data: Record<string, unknown>;
}

const row = (kind: string, record: Record<string, unknown>): PersonalRow => ({
  kind,
  id: typeof record.id === 'string' ? record.id : null,
  data: record,
});

/**
 * Everything the API holds about a user, as a file (`POST /account/export`,
 * through the data transfers): the platform's own records, then every
 * feature's (`PersonalDataRegistry`), from every tenant the user belongs
 * to. One row per record: `kind`, `id`, `data` (the record, as JSON in CSV
 * and Excel); a `membership` row opens each tenant's. Users only.
 */
@Injectable()
export class AccountTransfer implements DataExporter<PersonalRow> {
  readonly name = 'account';
  readonly subject = 'Account';
  readonly columns: readonly TransferColumn[] = [
    { key: 'kind' },
    { key: 'id' },
    { key: 'data' },
  ];

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly personalData: PersonalDataRegistry,
    private readonly tenancy: Tenancy,
    registry: DataTransferRegistry,
  ) {
    registry.registerExporter(this);
  }

  /** A user's own data: no permission to check; a system has none. */
  allowed(principal: Principal) {
    return principal.kind === 'user';
  }

  /**
   * A person spans tenants (docs/tenancy.md): their account's own records
   * (outside any tenant: the profile, sign-in methods, sessions, consents,
   * preferences, their account-level notifications and audit entries),
   * then, for each tenant they belong to (every membership, active or
   * not), what that tenant holds about them, read in that tenant's scope.
   * Never the row-level security bypass: each read is one tenant's.
   */
  async *batches(principal: Principal): AsyncIterable<PersonalRow[]> {
    if (principal.kind !== 'user') return;
    const user = principal;
    yield* this.inScope(null, this.accountRows(user));
    const tenants = await this.tenancy.none(() =>
      this.db
        .select({
          tenantId: memberships.tenantId,
          active: memberships.active,
          createdAt: memberships.createdAt,
          slug: tenants_.slug,
          name: tenants_.name,
        })
        .from(memberships)
        .innerJoin(tenants_, eq(tenants_.id, memberships.tenantId))
        .where(eq(memberships.userId, user.id))
        .orderBy(asc(memberships.createdAt)),
    );
    for (const membership of tenants) {
      yield [row('membership', { id: membership.tenantId, ...membership })];
      yield* this.inScope(
        membership.tenantId,
        this.tenantRows({ ...user, tenantId: membership.tenantId }),
      );
    }
  }

  /**
   * Runs each step of `source` in a tenant's scope (null: none): an async
   * generator resumes in the context of the `next()` that resumes it, so
   * each step is called inside `Tenancy.run()`.
   */
  private async *inScope<T>(
    tenantId: string | null,
    source: AsyncIterable<T>,
  ): AsyncIterable<T> {
    const iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const step = await (tenantId === null
        ? this.tenancy.none(() => iterator.next())
        : this.tenancy.run(tenantId, () => iterator.next()));
      if (step.done) return;
      yield step.value;
    }
  }

  /** The account's own records: global tables, and the rows of no tenant. */
  private async *accountRows(
    user: UserPrincipal,
  ): AsyncIterable<PersonalRow[]> {
    const key = principalKey(user);
    const [profile] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    if (profile) {
      const { passwordHash: _hash, ...rest } = profile;
      yield [row('profile', rest)];
    }
    yield (
      await this.db
        .select({
          provider: userIdentities.provider,
          subject: userIdentities.subject,
          email: userIdentities.email,
          createdAt: userIdentities.createdAt,
        })
        .from(userIdentities)
        .where(eq(userIdentities.userId, user.id))
    ).map((identity) => row('identity', identity));
    yield (
      await this.db
        .select({
          id: sessions.id,
          createdAt: sessions.createdAt,
          lastActiveAt: sessions.lastActiveAt,
          expiresAt: sessions.expiresAt,
          metadata: sessions.metadata,
        })
        .from(sessions)
        .where(eq(sessions.userId, user.id))
    ).map((session) => row('session', session));
    yield (
      await this.db
        .select({
          id: refreshTokens.id,
          createdAt: refreshTokens.createdAt,
          revoked: refreshTokens.revoked,
        })
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, user.id))
    ).map((token) => row('refreshToken', token));
    yield (
      await this.db.select().from(consents).where(eq(consents.userId, user.id))
    ).map((consent) => row('consent', consent));
    yield (
      await this.db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.recipient, key))
    ).map((preferences) => row('notificationPreferences', preferences));
    // Rows of no tenant: the policies show them outside a tenant (audit
    // entries), or everywhere (notifications: so only the null ones here).
    yield* this.pages(
      (cursor) =>
        this.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.recipient, key),
              isNull(notifications.tenantId),
              cursor ? lessThan(notifications.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(notifications.id))
          .limit(1000),
      'notification',
    );
    yield* this.auditEntries(key);
  }

  /** What the current tenant holds about the person. */
  private async *tenantRows(user: UserPrincipal): AsyncIterable<PersonalRow[]> {
    const key = principalKey(user);
    yield (
      await this.db
        .select({
          id: roles.id,
          key: roles.key,
          name: roles.name,
          expiresAt: userRoles.expiresAt,
        })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.userId, user.id))
    ).map((role) => row('role', role));
    yield (
      await this.db
        .select({ id: orgUnits.id, name: orgUnits.name })
        .from(userOrgUnits)
        .innerJoin(orgUnits, eq(orgUnits.id, userOrgUnits.orgUnitId))
        .where(eq(userOrgUnits.userId, user.id))
    ).map((unit) => row('orgUnit', unit));
    yield (
      await this.db
        .select()
        .from(settingOverrides)
        .where(
          and(
            eq(settingOverrides.scope, 'user'),
            eq(settingOverrides.scopeId, key),
          ),
        )
    ).map((setting) => row('setting', setting));
    yield (
      await this.db
        .select({
          id: recordSubscriptions.id,
          subject: recordSubscriptions.subject,
          recordId: recordSubscriptions.recordId,
          createdAt: recordSubscriptions.createdAt,
        })
        .from(recordSubscriptions)
        .where(eq(recordSubscriptions.subscriber, key))
    ).map((subscription) => row('subscription', subscription));
    yield* this.pages(
      (cursor) =>
        this.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.recipient, key),
              isNotNull(notifications.tenantId),
              cursor ? lessThan(notifications.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(notifications.id))
          .limit(1000),
      'notification',
    );
    yield* this.auditEntries(key);
    for (const source of this.personalData.all()) {
      for await (const batch of source.rows(user)) {
        yield batch.map((record) => row(source.name, record));
      }
    }
  }

  /** The person's audit entries the current scope sees. */
  private auditEntries(key: string) {
    return this.pages(
      (cursor) =>
        this.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actor, key),
              cursor ? lessThan(auditLog.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(auditLog.id))
          .limit(1000),
      'auditEntry',
    );
  }

  /** Keyset pages of a table with uuid ids, as rows of `kind`. */
  private async *pages(
    page: (cursor: string | undefined) => Promise<{ id: string }[]>,
    kind: string,
  ): AsyncIterable<PersonalRow[]> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await page(cursor);
      if (rows.length === 0) return;
      yield rows.map((record) => ({ kind, id: record.id, data: record }));
      cursor = rows[rows.length - 1]!.id;
    }
  }
}
