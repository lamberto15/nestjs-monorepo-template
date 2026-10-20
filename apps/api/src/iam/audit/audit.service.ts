import { Inject, Injectable, Optional } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { and, type SQL } from 'drizzle-orm';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  type PageQuery,
  toPage,
} from '../../core/http/pagination.js';
import { actorOf, type Principal } from '../auth/principal.js';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { encryptedProperties } from '../../core/encryption/encrypted-columns.js';
import { auditLog } from '../iam.tables.js';
import { PermissionCatalog } from '../access/permission-catalog.js';
import { ACTOR_NAMES, type ActorNames } from './actor-names.js';
import type {
  RecordChange,
  ResourceDefinition,
} from '../resources/resource.js';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

/**
 * The audit log: who did what. Pass the transaction of the change, so the
 * entry commits with it, or not at all.
 */
@Injectable()
export class AuditService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly catalog: PermissionCatalog,
    @Optional()
    @Inject(ACTOR_NAMES)
    private readonly actorNames?: ActorNames,
  ) {}

  async record(
    principal: Principal | null,
    entry: AuditEntry,
    db: Database | Transaction = this.db,
  ) {
    await db.insert(auditLog).values({
      ...actorOf(principal),
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details ?? null,
      ip: entry.ip ?? null,
    });
  }

  /**
   * Records a change to a record of a resource that declares `audit`: its
   * values when created or deleted, the fields that changed (from → to) when
   * updated. Sensitive fields are redacted, ignored ones left out. Pass the
   * change's transaction.
   */
  async recordChange(
    principal: Principal | null,
    resource: ResourceDefinition,
    change: RecordChange,
    db: Database | Transaction = this.db,
    ip?: string,
  ) {
    if (!resource.audit) {
      return;
    }
    // updatedAt changes on every write (timestamps()): it says nothing a diff needs.
    const ignore = new Set(['updatedAt', ...(resource.audit.ignore ?? [])]);
    const expand = new Set(resource.audit.expand ?? []);
    // Encrypted columns (core/encryption) are sensitive wherever they appear:
    // a diff must never hold the plaintext, nor the ciphertext it would reveal.
    const sensitive = new Set([
      ...this.catalog.sensitiveFields(resource.subject),
      ...encryptedProperties(),
    ]);
    const shown = (field: string, value: unknown) =>
      sensitive.has(field) ? '[redacted]' : value;
    const values = (record: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(record)
          .filter(([field]) => !ignore.has(field))
          .map(([field, value]) => [field, shown(field, value)]),
      );
    let details: Record<string, unknown>;
    if (change.action === 'updated') {
      const changes = diffFields(change.before, change.after, {
        ignore,
        expand: new Set([...expand].filter((field) => !sensitive.has(field))),
        shown,
      });
      if (Object.keys(changes).length === 0) {
        return; // nothing changed: nothing to record
      }
      details = { changes };
    } else {
      details = {
        values: values(
          change.action === 'deleted' ? change.before : change.after,
        ),
      };
    }
    const type =
      resource.subject.charAt(0).toLowerCase() + resource.subject.slice(1);
    await this.record(
      principal,
      {
        action: `${type}.${change.action}`,
        targetType: type,
        targetId: change.id,
        details,
        ip,
      },
      db,
    );
  }

  /** For a sign-in attempt, before anyone is signed in. */
  async recordAnonymous(label: string, entry: AuditEntry) {
    await this.db.insert(auditLog).values({
      actor: 'anonymous',
      actorLabel: label,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details ?? null,
      ip: entry.ip ?? null,
    });
  }

  /** A page of the log, newest first. */
  async page(query: PageQuery, where?: SQL) {
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(and(where, afterCursor(auditLog.id, query)))
        .orderBy(...pageOrder(auditLog.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, auditLog, where, query),
    ]);
    return toPage(rows, query, total);
  }

  /**
   * Entries with their actor's name now (`actorName`): a member or former
   * member, an API client of the tenant, named in one round for the page
   * (ACTOR_NAMES, the platform's PeopleService.names()); null for the
   * others (`anonymous`, `system:<key>`, a deleted account). `actorLabel`
   * stays what the entry stored when it was written.
   */
  async withActorNames<T extends { actor: string }>(
    entries: readonly T[],
  ): Promise<(T & { actorName: string | null })[]> {
    const names =
      this.actorNames && entries.length
        ? await this.actorNames.names(entries.map((entry) => entry.actor))
        : new Map<string, string | null>();
    return entries.map((entry) => ({
      ...entry,
      actorName: names.get(entry.actor) ?? null,
    }));
  }
}

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** What changed in a field: its value before and after. */
export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

/**
 * The fields of `after` whose value differs in `before` (from → to), as
 * the audit log records an update; record revisions reuse it. `expand`
 * fields (objects) give one entry per key that changed (`custom.region`);
 * `shown` may mask a value (the audit's `[redacted]`).
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  {
    ignore = new Set<string>(),
    expand = new Set<string>(),
    shown = (_field: string, value: unknown) => value,
  }: {
    ignore?: ReadonlySet<string>;
    expand?: ReadonlySet<string>;
    shown?: (field: string, value: unknown) => unknown;
  } = {},
): FieldChanges {
  const changes: FieldChanges = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field];
    if (ignore.has(field) || same(from, to)) {
      continue;
    }
    if (expand.has(field)) {
      // One entry per key that changed: `custom.region`, not the whole object.
      const was = asObject(from);
      const is = asObject(to);
      for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
        if (!same(was[key], is[key])) {
          changes[`${field}.${key}`] = {
            from: was[key] ?? null,
            to: is[key] ?? null,
          };
        }
      }
      continue;
    }
    changes[field] = { from: shown(field, from), to: shown(field, to) };
  }
  return changes;
}

/** Equal for the audit: dates by time, the rest by JSON. */
function same(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as Date).getTime() === new Date(b as Date).getTime();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
