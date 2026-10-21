import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { apiKeyId, generateApiKey, hashApiKey } from '../auth/api-keys.js';
import { normalizeCidr } from '../auth/client-ip.js';
import { principalKey, type UserPrincipal } from '../auth/principal.js';
import { SecurityAlertsService } from '../account/security-alerts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiClientCountsRegistry } from './api-client-counts.registry.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { apiClientRoles, apiClients, apiKeys } from '../iam.tables.js';

/** A key as the access API shows it: never the key or its hash. */
export interface ApiKeyView {
  id: string;
  keyId: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

/** An API client as the access API returns it. */
export interface ApiClientView {
  id: string;
  name: string;
  active: boolean;
  /** Requests a UTC day; null: no quota. */
  dailyQuota: number | null;
  /** IPv4/IPv6 CIDRs its keys may be used from; empty: any address. */
  allowedCidrs: string[];
  createdAt: Date;
  updatedAt: Date;
  keys: ApiKeyView[];
  roles: { roleId: string; expiresAt: Date | null }[];
  /**
   * How many webhook endpoints the client has (one grouped query for the
   * list). Absent with WEBHOOKS=off: not 0, as its endpoints may exist.
   */
  webhookEndpoints?: number;
}

/** The role grants of a change: ids, and when each one ends (none: never). */
export interface RoleGrants {
  roleIds: string[];
  roleExpiresAt?: Record<string, string>;
}

/**
 * The systems that call the API with a key. A key is shown once, when it is
 * made; only its public id and SHA-256 are stored. A client may hold several
 * keys: a rotation makes a new one and keeps the old one working for a grace
 * period, so the system switches without downtime. Keys can expire, are
 * revoked one by one, and record when they were last used. Every change is
 * audited, in its transaction.
 */
@Injectable()
export class ApiClientsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly securityAlerts: SecurityAlertsService,
    private readonly counts: ApiClientCountsRegistry,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  async list(): Promise<ApiClientView[]> {
    const clients = await this.db
      .select()
      .from(apiClients)
      .orderBy(asc(apiClients.name));
    return this.views(clients);
  }

  async findView(id: string, db: Database | Transaction = this.db) {
    const [client] = await db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    if (!client) {
      throw new NotFoundException(`API client ${id} not found.`);
    }
    return (await this.views([client], db))[0];
  }

  /** A client and its first key, shown this once. Roles are written by the caller (AccessAdminService). */
  async create(
    tx: Transaction,
    actor: UserPrincipal,
    input: {
      name: string;
      keyExpiresAt?: string;
      dailyQuota?: number | null;
      allowedCidrs?: string[];
    },
    ip?: string,
  ) {
    const [client] = await tx
      .insert(apiClients)
      .values({
        name: input.name,
        dailyQuota: input.dailyQuota ?? null,
        allowedCidrs: normalizeCidrs(input.allowedCidrs ?? []),
      })
      .returning()
      .catch((error: unknown) => {
        throw uniqueToConflict(error, 'An API client with this name exists.');
      });
    const key = await this.addKey(tx, client.id, input.keyExpiresAt);
    await this.audit.record(
      actor,
      {
        action: 'client.created',
        targetType: 'client',
        targetId: client.id,
        details: {
          name: client.name,
          keyId: apiKeyId(key),
          ...(client.dailyQuota !== null && { dailyQuota: client.dailyQuota }),
          ...(client.allowedCidrs.length > 0 && {
            allowedCidrs: client.allowedCidrs,
          }),
        },
        ip,
      },
      tx,
    );
    return { client, key };
  }

  /**
   * A new key; the client's current keys stop working after `graceSeconds`
   * (0: now). Returns the new key, shown this once.
   */
  async rotate(
    actor: UserPrincipal,
    id: string,
    options: { graceSeconds: number; expiresAt?: string },
    ip?: string,
  ) {
    const now = new Date();
    const until = new Date(now.getTime() + options.graceSeconds * 1000);
    const key = await inTransaction(this.txHost, async (tx) => {
      const client = await this.findView(id, tx);
      // Current keys end at the grace period's end (or sooner, if they expire earlier).
      await tx
        .update(apiKeys)
        .set(
          options.graceSeconds === 0
            ? { revokedAt: now }
            : { expiresAt: until },
        )
        .where(
          and(
            // api_keys is global (looked up before the tenant is known):
            // this tenant's keys only, said here.
            eq(apiKeys.tenantId, requireTenantId()),
            eq(apiKeys.clientId, id),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, until)),
          ),
        );
      const created = await this.addKey(tx, id, options.expiresAt);
      await this.audit.record(
        actor,
        {
          action: 'client.key-rotated',
          targetType: 'client',
          targetId: id,
          details: {
            name: client.name,
            keyId: apiKeyId(created),
            previousKeysEnd: until.toISOString(),
          },
          ip,
        },
        tx,
      );
      // The client itself is told (its webhook, when it subscribed to notification.created).
      await this.securityAlerts.alert(
        tx,
        'security.apiKeyRotated',
        principalKey({ kind: 'client', id }),
        {
          data: {
            clientId: id,
            keyId: apiKeyId(created),
            previousKeysEnd: until.toISOString(),
          },
        },
      );
      return created;
    });
    this.securityAlerts.deliverNow();
    return { ...(await this.findView(id)), key };
  }

  /** Stops one key now. */
  async revokeKey(
    actor: UserPrincipal,
    clientId: string,
    keyId: string,
    ip?: string,
  ) {
    await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.tenantId, requireTenantId()),
            eq(apiKeys.clientId, clientId),
            eq(apiKeys.id, keyId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning();
      if (!row) {
        throw new NotFoundException(`Key ${keyId} not found.`);
      }
      await this.audit.record(
        actor,
        {
          action: 'client.key-revoked',
          targetType: 'client',
          targetId: clientId,
          details: { keyId: row.keyId },
          ip,
        },
        tx,
      );
    });
  }

  async setActive(
    tx: Transaction,
    actor: UserPrincipal,
    id: string,
    active: boolean,
    ip?: string,
  ) {
    const [row] = await tx
      .update(apiClients)
      .set({ active })
      .where(eq(apiClients.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException(`API client ${id} not found.`);
    }
    await this.audit.record(
      actor,
      {
        action: active ? 'client.activated' : 'client.revoked',
        targetType: 'client',
        targetId: id,
        details: { name: row.name },
        ip,
      },
      tx,
    );
  }

  /**
   * Deletes a client for good, in `tx` with its audit entry: its keys stop
   * at once (their rows go with it, as its role grants and usage do,
   * through the foreign keys). What it did stays in the audit log, under
   * `client:<id>` and the name the entry records.
   */
  async remove(tx: Transaction, actor: UserPrincipal, id: string, ip?: string) {
    const [row] = await tx
      .delete(apiClients)
      .where(eq(apiClients.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException(`API client ${id} not found.`);
    }
    await this.audit.record(
      actor,
      {
        action: 'client.deleted',
        targetType: 'client',
        targetId: id,
        details: { name: row.name },
        ip,
      },
      tx,
    );
    return row;
  }

  /** Sets (or, with null, removes) the client's daily request quota. */
  async setQuota(
    tx: Transaction,
    actor: UserPrincipal,
    id: string,
    dailyQuota: number | null,
    ip?: string,
  ) {
    const [before] = await tx
      .select({ dailyQuota: apiClients.dailyQuota })
      .from(apiClients)
      .where(eq(apiClients.id, id));
    if (!before) {
      throw new NotFoundException(`API client ${id} not found.`);
    }
    if (before.dailyQuota === dailyQuota) {
      return;
    }
    await tx
      .update(apiClients)
      .set({ dailyQuota })
      .where(eq(apiClients.id, id));
    await this.audit.record(
      actor,
      {
        action: 'client.quota-changed',
        targetType: 'client',
        targetId: id,
        details: { dailyQuota: { from: before.dailyQuota, to: dailyQuota } },
        ip,
      },
      tx,
    );
  }

  /** Replaces the client's IP allowlist (empty: any address); 400 for a malformed CIDR. */
  async setAllowedCidrs(
    tx: Transaction,
    actor: UserPrincipal,
    id: string,
    allowedCidrs: string[],
    ip?: string,
  ) {
    const to = normalizeCidrs(allowedCidrs);
    const [before] = await tx
      .select({ allowedCidrs: apiClients.allowedCidrs })
      .from(apiClients)
      .where(eq(apiClients.id, id));
    if (!before) {
      throw new NotFoundException(`API client ${id} not found.`);
    }
    if (before.allowedCidrs.join() === to.join()) {
      return;
    }
    await tx
      .update(apiClients)
      .set({ allowedCidrs: to })
      .where(eq(apiClients.id, id));
    await this.audit.record(
      actor,
      {
        action: 'client.allowlist-changed',
        targetType: 'client',
        targetId: id,
        details: { allowedCidrs: { from: before.allowedCidrs, to } },
        ip,
      },
      tx,
    );
  }

  private async addKey(tx: Transaction, clientId: string, expiresAt?: string) {
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      throw new BadRequestException('A key can’t end in the past.');
    }
    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      // The client's tenant (the key is found by its id before any tenant).
      tenantId: requireTenantId('A key'),
      clientId,
      keyId: apiKeyId(key)!,
      keyHash: hashApiKey(key),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
    return key;
  }

  private async views(
    clients: (typeof apiClients.$inferSelect)[],
    db: Database | Transaction = this.db,
  ): Promise<ApiClientView[]> {
    const ids = clients.map((client) => client.id);
    if (ids.length === 0) {
      return [];
    }
    const [keys, roles, counts] = await Promise.all([
      db
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.tenantId, requireTenantId()),
            inArray(apiKeys.clientId, ids),
          ),
        )
        .orderBy(asc(apiKeys.createdAt)),
      // Grants still running only: an ended one is gone, never reported (so
      // never echoed back into a change of roles, #114).
      db
        .select()
        .from(apiClientRoles)
        .where(
          and(
            inArray(apiClientRoles.clientId, ids),
            or(
              isNull(apiClientRoles.expiresAt),
              gt(apiClientRoles.expiresAt, new Date()),
            ),
          ),
        ),
      this.counts.counts(ids, db),
    ]);
    return clients.map((client) => ({
      id: client.id,
      name: client.name,
      active: client.active,
      dailyQuota: client.dailyQuota,
      allowedCidrs: client.allowedCidrs,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      keys: keys
        .filter((key) => key.clientId === client.id)
        .map(({ id, keyId, createdAt, expiresAt, revokedAt, lastUsedAt }) => ({
          id,
          keyId,
          createdAt,
          expiresAt,
          revokedAt,
          lastUsedAt,
        })),
      roles: roles
        .filter((role) => role.clientId === client.id)
        .map(({ roleId, expiresAt }) => ({ roleId, expiresAt })),
      ...(counts.has('webhookEndpoints') && {
        webhookEndpoints: counts.get('webhookEndpoints')!.get(client.id) ?? 0,
      }),
    }));
  }
}

/** CIDRs in canonical form, duplicates dropped; a malformed one is a 400 `invalid_cidr`. */
function normalizeCidrs(cidrs: string[]) {
  const normalized = cidrs.map((cidr) => {
    const result = normalizeCidr(cidr);
    if (typeof result !== 'string') {
      throw new BadRequestException({
        code: 'invalid_cidr',
        message: result.error,
      });
    }
    return result;
  });
  return [...new Set(normalized)];
}

/** A unique-constraint violation as a 409 with a message; anything else as is. */
export function uniqueToConflict(error: unknown, message: string) {
  const code =
    (error as { code?: string })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code;
  return code === '23505' ? new ConflictException(message) : error;
}
