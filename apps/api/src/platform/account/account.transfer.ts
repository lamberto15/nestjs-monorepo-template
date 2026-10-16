import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, lt as lessThan } from 'drizzle-orm';
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

/**
 * Everything the API holds about a user, as a file (`POST /account/export`,
 * through the data transfers): the platform's own records, then every
 * feature's (`PersonalDataRegistry`). One row per record: `kind`, `id`,
 * `data` (the record, as JSON in CSV and Excel). Users only.
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
    registry: DataTransferRegistry,
  ) {
    registry.registerExporter(this);
  }

  /** A user's own data: no permission to check; a system has none. */
  allowed(principal: Principal) {
    return principal.kind === 'user';
  }

  async *batches(principal: Principal): AsyncIterable<PersonalRow[]> {
    if (principal.kind !== 'user') return;
    const user = principal;
    const key = principalKey(user);
    const row = (
      kind: string,
      record: Record<string, unknown>,
    ): PersonalRow => ({
      kind,
      id: typeof record.id === 'string' ? record.id : null,
      data: record,
    });

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
              cursor ? lessThan(notifications.id, cursor) : undefined,
            ),
          )
          .orderBy(desc(notifications.id))
          .limit(1000),
      'notification',
    );
    yield* this.pages(
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
    for (const source of this.personalData.all()) {
      for await (const batch of source.rows(user as UserPrincipal)) {
        yield batch.map((record) => row(source.name, record));
      }
    }
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
