import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import {
  ForbiddenException,
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { IAM_OPTIONS, type IamOptions } from '../iam.options.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { REDIS, closeRedis } from '../../core/redis/redis.js';
import {
  type ListQuery,
  queryMatches,
  queryReads,
} from '../../core/http/list-query.js';
import {
  AbilityBuilder,
  createMongoAbility,
  subject as asSubject,
  type MongoAbility,
} from '@casl/ability';
import { permittedFieldsOf } from '@casl/ability/extra';
import { and, eq, gt, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  isSystemPrincipal,
  principalKey,
  type Principal,
} from '../auth/principal.js';
import {
  apiClientRoles,
  teamTree,
  rolePermissions,
  userTeams,
  userRoles,
} from '../iam.tables.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { PermissionCatalog } from './permission-catalog.js';
import {
  type AccessContext,
  isAll,
  type PermissionInput,
} from './permissions.js';

type AppAbility = MongoAbility;

interface Cached {
  version: number;
  permissions: PermissionInput[];
  ability: AppAbility;
}

/**
 * Answers "may this principal do this?" with CASL. A user's
 * permissions come from their roles in the database; an API client's are
 * fixed in code (`clientPermissions` of the declarations); the system
 * principal's are its job's (`systemJobs`), nothing more. User abilities
 * are cached, and the whole cache is dropped whenever roles, permissions or
 * assignments change, so a change applies on the next request, on every
 * instance: the invalidation is published through Redis. A cached ability
 * is rebuilt after a minute anyway.
 */
/** The field a permission with `fields: []` grants: none that exists. */
const NO_FIELDS = '$none';

/**
 * Whether `field`, which some rule lets `action` reach, is hidden on some
 * of the records `action` reaches: what a filter, a sort or a search on it
 * would reveal. CASL's `can(action, subject, field)` on a subject type is
 * true as soon as one rule grants the field, conditions or not, so the
 * rules are read (`rulesFor(action, subject, field)`: those for the field,
 * the one that wins first; `possibleRulesFor(action, subject)`: every rule
 * of the action, whatever its fields).
 *
 * - A rule with fields and conditions that forbids it (inverted), ahead of
 *   any grant without conditions: hidden where its conditions hold.
 * - A grant of the field without conditions: shown on every record.
 * - Otherwise every rule that lets `reach` reach records must have a
 *   rule of `action` grant the field on the same records: the same
 *   conditions. `read` own notes with every field and `read` the team's
 *   with `fields: []` leaves `body` hidden on the team's; `read` own notes
 *   alone shows it on every note the read reaches.
 *
 * `reach` is the action whose rows the query matches, when it isn't
 * `action` itself: the recycle bin lists what the caller may `restore`, a
 * bulk run selects what it may `delete`, and so on, while what they see of
 * those rows is still what `read` grants. `read` own notes with every field
 * and `restore` the team's leaves `body` hidden on the team's deleted notes.
 */
export function hiddenOnSomeRecords(
  ability: AppAbility,
  action: string,
  subject: string,
  field: string,
  reach: string = action,
): boolean {
  const rules = ability.rulesFor(action, subject, field);
  for (const rule of rules) {
    if (!rule.inverted && !rule.conditions) {
      return false;
    }
    if (rule.inverted && rule.fields && rule.conditions) {
      return true;
    }
  }
  const granted = new Set(
    rules
      .filter((rule) => !rule.inverted)
      .map((rule) => JSON.stringify(rule.conditions)),
  );
  return ability
    .possibleRulesFor(reach, subject)
    .some(
      (rule) => !rule.inverted && !granted.has(JSON.stringify(rule.conditions)),
    );
}

@Injectable()
export class AccessService implements OnModuleInit, OnApplicationShutdown {
  private version = 0;
  /** This instance, so it ignores its own invalidations coming back. */
  private readonly instanceId = randomUUID();
  private subscriber?: Redis;
  private readonly cache = new Map<string, Cached>();
  private static readonly MAX_AGE_MS = 60_000;
  /** Until when each cached ability holds: a minute at most, never past a grant's expiry. */
  private readonly validUntil = new Map<string, number>();

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly catalog: PermissionCatalog,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(IAM_OPTIONS) options: IamOptions,
  ) {
    this.softDeleted = new Map(
      (options.resources ?? []).flatMap((resource) =>
        resource.softDelete
          ? [[resource.subject, resource.softDelete.table]]
          : [],
      ),
    );
  }

  /** The soft-deletable subjects' tables (their resource's `softDelete`). */
  private readonly softDeleted: Map<string, { deletedAt: AnyPgColumn }>;

  /** Pub/sub channels ignore ioredis' key prefix: the prefix goes into the name. */
  private get channel() {
    return `${this.redis.options.keyPrefix ?? ''}access:invalidate`;
  }

  async onModuleInit() {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (_channel: string, from: string) => {
      if (from !== this.instanceId) {
        this.clear();
      }
    });
    await this.subscriber.subscribe(this.channel);
  }

  async onApplicationShutdown() {
    if (this.subscriber) {
      await closeRedis(this.subscriber);
    }
  }

  /**
   * Drops every cached ability, here and on every other instance: call after
   * any change to roles, permissions or assignments.
   */
  invalidate() {
    this.clear();
    void this.redis
      .publish(this.channel, this.instanceId)
      .catch(() => undefined);
  }

  private clear() {
    this.version++;
    this.cache.clear();
    this.validUntil.clear();
  }

  /** Whether the principal may do `action` on `subject`: on this record, or on any when there is none. */
  async can(
    principal: Principal | null,
    action: string,
    subject: string,
    record?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!principal) {
      return false;
    }
    // A deleted record (soft delete) can only be restored.
    if (
      record &&
      action !== 'restore' &&
      this.softDeleted.has(subject) &&
      record.deletedAt != null
    ) {
      return false;
    }
    const { ability } = await this.load(principal);
    return record
      ? ability.can(action, asSubject(subject, { ...record }))
      : ability.can(action, subject);
  }

  /**
   * The record without the declared fields the principal may not `action`
   * (field-level permissions): what a response may show. Undeclared fields
   * are always kept.
   */
  async redact<T extends Record<string, unknown>>(
    principal: Principal,
    action: string,
    subject: string,
    record: T,
  ): Promise<Partial<T>> {
    const declared = this.catalog.declaredFields(subject);
    if (declared.length === 0) {
      return record;
    }
    const { ability } = await this.load(principal);
    const allowed = new Set(
      permittedFieldsOf(ability, action, asSubject(subject, { ...record }), {
        fieldsFrom: (rule) => rule.fields ?? declared,
      }),
    );
    return Object.fromEntries(
      Object.entries(record).filter(
        ([field]) => !declared.includes(field) || allowed.has(field),
      ),
    ) as Partial<T>;
  }

  /** `redact()` for each record of a list. */
  redactAll<T extends Record<string, unknown>>(
    principal: Principal,
    action: string,
    subject: string,
    records: T[],
  ) {
    return Promise.all(
      records.map((record) => this.redact(principal, action, subject, record)),
    );
  }

  /**
   * The declared fields among `changes` the principal may not `action` on
   * this record: a write route answers 403 when there is any.
   */
  async forbiddenFields(
    principal: Principal,
    action: string,
    subject: string,
    changes: Record<string, unknown>,
    record?: Record<string, unknown>,
  ): Promise<string[]> {
    const declared = this.catalog.declaredFields(subject);
    const touched = Object.keys(changes).filter(
      (field) => declared.includes(field) && changes[field] !== undefined,
    );
    if (touched.length === 0) {
      return [];
    }
    const { ability } = await this.load(principal);
    const target = record ? asSubject(subject, { ...record }) : subject;
    return touched.filter((field) => !ability.can(action, target, field));
  }

  /**
   * The declared fields of `subject` the principal may `action` on no
   * record at all (field-level permissions, conditions aside): what a
   * description of the subject leaves out (GET /v1/lists/{subject}). A
   * field allowed on some records only is not among them (see
   * `conditionalFields()`): `redact()` decides per record.
   */
  async deniedFields(
    principal: Principal,
    action: string,
    subject: string,
  ): Promise<string[]> {
    const declared = this.catalog.declaredFields(subject);
    if (declared.length === 0) {
      return [];
    }
    const { ability } = await this.load(principal);
    return declared.filter((field) => !ability.can(action, subject, field));
  }

  /**
   * The declared fields of `subject` the principal may `action` on some of
   * the records they may `action` only: a rule reaches records without
   * granting the field on them (a grant of the field with conditions beside
   * a rule with other conditions, or none, and fewer fields), or a rule
   * with conditions forbids it on some records. `redact()` shows or
   * hides them per record, but a query that filters, searches or sorts by
   * one would tell its value on the records that hide it (which rows match,
   * in which order), so lists refuse that (`assertQueryFields`) and the
   * global search leaves them out. Administrators and grants without
   * conditions have none.
   */
  async conditionalFields(
    principal: Principal,
    action: string,
    subject: string,
    /** The action whose rows are matched, when another (see hiddenOnSomeRecords). */
    reach: string = action,
  ): Promise<string[]> {
    const declared = this.catalog.declaredFields(subject);
    if (declared.length === 0) {
      return [];
    }
    const { ability } = await this.load(principal);
    return declared.filter(
      (field) =>
        ability.can(action, subject, field) &&
        hiddenOnSomeRecords(ability, action, subject, field, reach),
    );
  }

  /**
   * The declared fields a query may not filter, search or sort by:
   * `deniedFields()` and `conditionalFields()` together.
   */
  async unmatchableFields(
    principal: Principal,
    action: string,
    subject: string,
  ): Promise<string[]> {
    const [denied, conditional] = await Promise.all([
      this.deniedFields(principal, action, subject),
      this.conditionalFields(principal, action, subject),
    ]);
    return [...denied, ...conditional];
  }

  /**
   * A 403 `field_forbidden` when a validated list query (`listQuery()`)
   * filters, searches, sorts or selects by a field `deniedFields()` hides,
   * or filters, searches or sorts by one `conditionalFields()` shows on some
   * records only: `redact()` takes such a value out of the items, and
   * which rows match (or their order) would still tell it, one probe at a
   * time. Selecting (`fields=`) a conditional field is allowed: `redact()`
   * decides per record what is shown. Every list of a subject with declared
   * fields calls it after validating the query, and so do the exports,
   * bulk runs and reports that take the list's filters.
   *
   * `reach`: the action whose rows the query matches (`sqlFilter()`'s), when
   * not `read`: `restore` for a recycle bin, a bulk run's action, an
   * exporter's `action`. A field is matchable only where `read` shows it
   * on every row that action reaches.
   */
  async assertQueryFields(
    principal: Principal,
    subject: string,
    query: ListQuery,
    { reach = 'read' }: { reach?: string } = {},
  ): Promise<void> {
    // A subject with no declared fields hides none: nothing to check, whatever
    // validated the query. Otherwise only a listQuery() query (queryReads throws).
    if (this.catalog.declaredFields(subject).length === 0) {
      return;
    }
    const reads = queryReads(query);
    if (reads.length === 0) {
      return;
    }
    const matching = queryMatches(query);
    const [denied, conditional] = await Promise.all([
      this.deniedFields(principal, 'read', subject),
      this.conditionalFields(principal, 'read', subject, reach),
    ]);
    const forbidden = reads.filter(
      (field) =>
        denied.includes(field) ||
        (conditional.includes(field) && matching.includes(field)),
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not filter, search, sort or select by: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }

  /** The principal's permissions, as stored (an administrator's is ALL). */
  async permissions(principal: Principal): Promise<PermissionInput[]> {
    return (await this.load(principal)).permissions;
  }

  /**
   * The SQL filter for the records of `subject` this principal may `action`:
   * `undefined` for all of them, or a condition (`false` for none). Lists
   * filter in the query; record checks use `can()`. Every condition used on
   * that action needs its `sql()` form.
   */
  async sqlFilter(
    principal: Principal,
    subject: string,
    action: string,
    /** The recycle bin (soft-deletable subjects): deleted rows only, instead of live ones. */
    { deleted = false }: { deleted?: boolean } = {},
  ): Promise<SQL | undefined> {
    const table = this.softDeleted.get(subject);
    const permitted = await this.permittedFilter(principal, subject, action);
    if (!table) {
      return permitted;
    }
    // Deleted rows never reach a list, a count or an export, whatever the filter says.
    const state = deleted
      ? isNotNull(table.deletedAt)
      : isNull(table.deletedAt);
    return permitted ? and(permitted, state) : state;
  }

  private async permittedFilter(
    principal: Principal,
    subject: string,
    action: string,
  ): Promise<SQL | undefined> {
    const permissions = (await this.load(principal)).permissions.filter(
      (permission) =>
        isAll(permission) ||
        (permission.subject === subject && permission.action === action),
    );
    if (permissions.some((permission) => !permission.conditions.length)) {
      return undefined;
    }
    const filters = permissions.map((permission) =>
      and(...this.catalog.sqlConditions(principal, permission)),
    );
    return filters.length ? or(...filters) : sql`false`;
  }

  private async load(principal: Principal): Promise<Cached> {
    if (principal.kind === 'system' && !isSystemPrincipal(principal)) {
      // `kind: 'system'` read from data: nothing, and never the cached
      // ability of the real one (the cache is keyed by principalKey).
      return {
        version: this.version,
        permissions: [],
        ability: this.build(principal, [], { teamIds: [] }),
      };
    }
    // Per tenant: the same person holds other roles in another tenant, and
    // the system principal's conditions read the job's tenant's rows.
    // A break-glass request's ability is its grant's, never the person's
    // own in that tenant (an operator may also be a member there).
    const key = `${currentTenantId() ?? '-'}:${principalKey(principal)}${principal.kind === 'user' && principal.breakGlass ? `:break-glass:${principal.breakGlass.grantId}` : ''}`;
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.version === this.version &&
      Date.now() < (this.validUntil.get(key) ?? 0)
    ) {
      return cached;
    }
    const version = this.version;
    const [{ permissions, nextExpiry }, context] = await Promise.all([
      this.loadPermissions(principal),
      this.loadContext(principal),
    ]);
    const built: Cached = {
      version,
      permissions,
      ability: this.build(principal, permissions, context),
    };
    // Only cache what was built against the current version, and never past
    // the next grant that expires (nor a minute).
    if (version === this.version) {
      this.cache.set(key, built);
      this.validUntil.set(
        key,
        Math.min(Date.now() + AccessService.MAX_AGE_MS, nextExpiry ?? Infinity),
      );
    }
    return built;
  }

  /**
   * A user's permissions: from their unexpired role grants. An API client's:
   * what every client may do (`clientPermissions`), and its own unexpired
   * role grants. With when the first of those grants expires. The system's:
   * what its job declares.
   */
  private async loadPermissions(principal: Principal): Promise<{
    permissions: PermissionInput[];
    nextExpiry?: number;
  }> {
    if (principal.kind === 'system') {
      // Made in code (load() turned away any other), for a declared job.
      return {
        permissions: this.catalog.systemJob(principal.id)?.permissions ?? [],
      };
    }
    if (!currentTenantId()) {
      // Roles are per tenant: without one (a user who has none), none.
      return { permissions: [] };
    }
    if (principal.kind === 'user' && principal.breakGlass) {
      // An operator reading a tenant through a break-glass grant: every
      // read action of the catalog, no condition, and nothing else (no
      // role of theirs there counts). The transactions are read only too.
      return { permissions: this.catalog.readPermissions() };
    }
    const now = new Date();
    const grants = principal.kind === 'user' ? userRoles : apiClientRoles;
    const holder =
      principal.kind === 'user' ? userRoles.userId : apiClientRoles.clientId;
    const rows = await this.db
      .select({
        subject: rolePermissions.subject,
        action: rolePermissions.action,
        conditions: rolePermissions.conditions,
        fields: rolePermissions.fields,
        expiresAt: grants.expiresAt,
      })
      .from(rolePermissions)
      .innerJoin(grants, eq(grants.roleId, rolePermissions.roleId))
      .where(
        and(
          eq(holder, principal.id),
          or(isNull(grants.expiresAt), gt(grants.expiresAt, now)),
        ),
      );
    const expiries = rows
      .map((row) => row.expiresAt?.getTime())
      .filter((time): time is number => time !== undefined);
    const permissions: PermissionInput[] = rows.map(
      ({ subject, action, conditions, fields }) => ({
        subject,
        action,
        conditions,
        fields,
      }),
    );
    return {
      permissions:
        principal.kind === 'client'
          ? [...this.catalog.clientPermissions, ...permissions]
          : permissions,
      nextExpiry: expiries.length ? Math.min(...expiries) : undefined,
    };
  }

  /** The principal's teams and every unit below them (users only). */
  private async loadContext(principal: Principal): Promise<AccessContext> {
    if (
      principal.kind !== 'user' ||
      !currentTenantId() ||
      principal.breakGlass
    ) {
      return { teamIds: [] };
    }
    const rows = await this.db
      .selectDistinct({ id: teamTree.descendantId })
      .from(teamTree)
      .innerJoin(userTeams, eq(userTeams.teamId, teamTree.ancestorId))
      .where(eq(userTeams.userId, principal.id));
    return { teamIds: rows.map((row) => row.id) };
  }

  private build(
    principal: Principal,
    permissions: PermissionInput[],
    context: AccessContext,
  ): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const permission of permissions) {
      const conditions = isAll(permission)
        ? undefined
        : this.catalog.caslConditions(principal, permission, context);
      // [] (none of the restrictable fields) still has to restrict: CASL reads [] as "all".
      const fields = permission.fields
        ? permission.fields.length
          ? permission.fields
          : [NO_FIELDS]
        : undefined;
      if (conditions) {
        can(permission.action, permission.subject, fields, conditions);
      } else if (fields) {
        can(permission.action, permission.subject, fields);
      } else {
        can(permission.action, permission.subject);
      }
    }
    return build();
  }
}
