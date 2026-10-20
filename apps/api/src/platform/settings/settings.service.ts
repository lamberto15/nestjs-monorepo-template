import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { actsAsOperator } from '../../iam/auth/operator-only.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  currentTenantId,
  requireTenantId,
  tenantKey,
} from '../../core/tenancy/tenant-scope.js';
import {
  apiClients,
  memberships,
  teams,
  userTeams,
} from '../../iam/iam.tables.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { resolveSetting, type SettingSource } from './setting-resolution.js';
import type {
  SetPlatformSettingDto,
  SetSettingDto,
} from './setting.schemas.js';
import {
  type SettingValueSchema,
  settingValueSchema,
} from './setting-value-schema.js';
import type {
  PlatformSettingValue,
  SettingDeclaration,
  SettingOverride,
  SettingScope,
} from './setting.types.js';
import { platformSettingValues, settingOverrides } from './settings.tables.js';

/** A setting as a caller sees it: its value for them, what values it takes, and what they may change. */
export interface SettingView extends SettingValueSchema {
  key: string;
  label: string;
  description: string | null;
  flag: boolean;
  scopes: readonly SettingScope[];
  public: boolean;
  value: unknown;
  source: SettingSource;
  default: unknown;
  /** May set and remove its value at every scope it takes (PUT/DELETE /settings/{key}). */
  canEdit: boolean;
  /** May set their own value (PUT/DELETE /settings/{key}/mine). */
  canSetMine: boolean;
  /** What the operators set for every tenant, if anything. */
  platform: PlatformSettingValue | null;
  /** May set and remove the platform value (PUT/DELETE /settings/{key}/platform): an operator. */
  canEditPlatform: boolean;
}

type Row = typeof settingOverrides.$inferSelect;
type PlatformRow = typeof platformSettingValues.$inferSelect;

interface CachedPlatform {
  version: string | undefined;
  loadedAt: number;
  byKey: Map<string, PlatformRow>;
}

interface Cached {
  version: string | undefined;
  loadedAt: number;
  byKey: Map<string, Row[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** No tenant: nothing stored applies, every setting is its default. */
const NOTHING: Cached = { version: undefined, loadedAt: 0, byKey: new Map() };

/**
 * Settings and feature flags: the declarations are code
 * (`PlatformModule.forRoot({ settings })`), the values administrators and
 * users set are rows of their tenant (row-level security, docs/tenancy.md),
 * read through one cache per tenant and instance. Every change increments
 * the tenant's `tenant:<id>:settings:version` in Redis after its commit;
 * each read compares it with the cached one, so a change applies on the
 * next request everywhere (as custom fields do), and only that tenant's
 * cache is reloaded. Without Redis the cache holds for FALLBACK_TTL_MS at
 * most. Outside any tenant (a user without one, a job of none) settings
 * are their defaults, or what the operators set for every tenant.
 *
 * Those platform values (`setPlatform()`) are rows of a global table, one
 * cache per instance, refreshed through `settings:platform:version` the
 * same way.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');
  private readonly byKey = new Map<string, SettingDeclaration<any>>();
  /** Each declaration's value schema, derived once at start (setting-value-schema.ts). */
  private readonly valueSchemas = new Map<string, SettingValueSchema>();
  /** Deployment limits on values (`restrict()`), by key. */
  private readonly restrictions = new Map<
    string,
    ((value: unknown) => string | undefined)[]
  >();
  /** Per tenant, the least recently loaded first (dropped past MAX_CACHED_TENANTS). */
  private readonly caches = new Map<string, Cached>();
  private static readonly MAX_CACHED_TENANTS = 1_000;
  private static readonly VERSION_KEY = 'settings:version';
  private static readonly PLATFORM_VERSION_KEY = 'settings:platform:version';
  private platformCache: CachedPlatform | undefined;
  private static readonly FALLBACK_TTL_MS = 5_000;
  private static readonly MAX_AGE_MS = 5 * 60_000;

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PLATFORM_OPTIONS) options: PlatformOptions,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicy,
    private readonly tenancy: Tenancy,
  ) {
    for (const declaration of options.settings ?? []) {
      if (this.byKey.has(declaration.key)) {
        throw new Error(`Setting "${declaration.key}" is declared twice.`);
      }
      if (!declaration.schema.safeParse(declaration.default).success) {
        throw new Error(
          `Setting "${declaration.key}": its default does not pass its schema.`,
        );
      }
      this.byKey.set(declaration.key, declaration);
      this.valueSchemas.set(
        declaration.key,
        settingValueSchema(declaration.schema),
      );
    }
  }

  /** The declared settings, in declaration order. */
  declarations() {
    return [...this.byKey.values()];
  }

  /** A declared setting, or a 404. */
  declaration(key: string): SettingDeclaration<any> {
    const declaration = this.byKey.get(key);
    if (!declaration) {
      throw new NotFoundException(`No setting "${key}".`);
    }
    return declaration;
  }

  /**
   * Refuses values of `key` the deployment doesn't allow, when they are set
   * (`check` answers why, or undefined): the env's ceiling on what a
   * tenant may choose (the auth.* settings, platform/auth-policy). A
   * refused value is a 400 `setting_not_allowed`. What is already stored
   * stays: whoever reads the setting applies the ceiling again.
   */
  restrict<T>(
    declaration: SettingDeclaration<T>,
    check: (value: T) => string | undefined,
  ) {
    this.declaration(declaration.key);
    const checks = this.restrictions.get(declaration.key) ?? [];
    checks.push(check as (value: unknown) => string | undefined);
    this.restrictions.set(declaration.key, checks);
  }

  /** A 400 `setting_not_allowed` when a restriction refuses the value. */
  private assertAllowed(key: string, value: unknown) {
    for (const check of this.restrictions.get(key) ?? []) {
      const reason = check(value);
      if (reason) {
        throw new BadRequestException({
          code: 'setting_not_allowed',
          message: reason,
          errors: [{ path: 'value', message: reason }],
        });
      }
    }
  }

  /**
   * Whether any value that applies to the principal is `true`: the
   * tenant's, one of their teams', their own (when the setting takes a
   * user scope). For policies whose `true` is the strict side: a narrower
   * scope's `false` doesn't exempt anyone from a wider scope's `true`, as
   * the usual precedence (`resolve()`) would. No rollout counts. The
   * operators' platform `true` counts as the widest scope; their `false`,
   * even enforced, exempts no one either.
   */
  async anyOn(
    declaration: SettingDeclaration<boolean>,
    principal: Principal,
  ): Promise<boolean> {
    if ((await this.platformValue(declaration.key))?.value === true) {
      return true;
    }
    const on = ((await this.load()).byKey.get(declaration.key) ?? []).filter(
      (override) => override.value === true,
    );
    if (on.some((override) => override.scope === 'tenant')) {
      return true;
    }
    const scopes = declaration.scopes ?? ['tenant'];
    if (
      scopes.includes('user') &&
      on.some(
        (override) =>
          override.scope === 'user' &&
          override.scopeId === principalKey(principal),
      )
    ) {
      return true;
    }
    const teams = on.filter((override) => override.scope === 'team');
    if (
      !scopes.includes('team') ||
      principal.kind !== 'user' ||
      !teams.length
    ) {
      return false;
    }
    const mine = new Set(await this.teamsOf(principal.id));
    return teams.some((override) => mine.has(override.scopeId));
  }

  /** The value of a setting for a principal (none: for everyone). */
  async get<T>(
    declaration: SettingDeclaration<T>,
    principal: Principal | null = null,
  ): Promise<T> {
    return (await this.resolve(declaration, principal)).value;
  }

  /** Whether a flag is on for a principal (none: for everyone, rollouts aside). */
  enabled(
    declaration: SettingDeclaration<boolean>,
    principal: Principal | null = null,
  ) {
    return this.get(declaration, principal);
  }

  /** A setting's value for a principal, and where it comes from. */
  async resolve<T>(
    declaration: SettingDeclaration<T>,
    principal: Principal | null,
  ) {
    const overrides = (await this.load()).byKey.get(declaration.key) ?? [];
    const teams =
      principal?.kind === 'user' &&
      (declaration.scopes ?? []).includes('team') &&
      overrides.some((override) => override.scope === 'team')
        ? await this.teamsOf(principal.id)
        : [];
    return resolveSetting(
      declaration,
      overrides,
      principal,
      teams,
      currentTenantId(),
      await this.platformValue(declaration.key),
    );
  }

  /** Every setting the caller may see, with their value for them. */
  async effective(principal: Principal, { all = false } = {}) {
    const canEdit = await this.canEdit(principal);
    const canEditPlatform = await this.canEditPlatform(principal, canEdit);
    const views: SettingView[] = [];
    for (const declaration of this.byKey.values()) {
      if (declaration.public === false && !all) continue;
      views.push(
        await this.view(declaration, principal, canEdit, canEditPlatform),
      );
    }
    return views;
  }

  /**
   * Whether the principal may set and remove a setting's shared values
   * (PUT and DELETE /settings/{key}): the very policy those routes check,
   * the same at every scope, so one answer holds for all of them.
   */
  canEdit(principal: Principal) {
    return this.accessPolicy.manageSettings(principal);
  }

  /**
   * Whether the principal may set and remove the platform values (PUT and
   * DELETE /settings/{key}/platform): Access.manageSettings, acting in the
   * operator tenant (the routes' own checks).
   */
  async canEditPlatform(principal: Principal, canEdit?: boolean) {
    return (
      (canEdit ?? (await this.canEdit(principal))) &&
      actsAsOperator(this.tenancy, principal)
    );
  }

  async view(
    declaration: SettingDeclaration<any>,
    principal: Principal,
    canEdit?: boolean,
    canEditPlatform?: boolean,
  ): Promise<SettingView> {
    const { value, source } = await this.resolve(declaration, principal);
    const scopes = declaration.scopes ?? ['tenant'];
    canEdit ??= await this.canEdit(principal);
    return {
      ...this.valueSchemas.get(declaration.key)!,
      key: declaration.key,
      label: declaration.label,
      description: declaration.description ?? null,
      flag: declaration.flag === true,
      scopes,
      public: declaration.public !== false,
      value,
      source,
      default: declaration.default,
      canEdit,
      // PUT /settings/{key}/mine takes anyone, for a setting set per user.
      canSetMine: scopes.includes('user'),
      platform: (await this.platformValue(declaration.key)) ?? null,
      canEditPlatform:
        canEditPlatform ?? (await this.canEditPlatform(principal, canEdit)),
    };
  }

  /** The stored overrides of a setting, every scope. */
  async overrides(key: string): Promise<Row[]> {
    this.declaration(key);
    return (await this.load()).byKey.get(key) ?? [];
  }

  /**
   * Sets a setting for a scope (replacing what that scope had), checked
   * against the declaration: the scope must be one it allows, the value
   * must pass its schema, a rollout is for flags at the tenant scope.
   * Audited; applies everywhere on the next request.
   */
  async set(actor: Principal, key: string, dto: SetSettingDto, ip?: string) {
    const declaration = this.declaration(key);
    const scope = dto.scope;
    const scopeId = await this.scopeId(declaration, scope, dto.scopeId);
    const issues: { path: string; message: string }[] = [];
    if (dto.value === undefined && dto.rollout == null) {
      issues.push({ path: 'value', message: 'A value is required.' });
    }
    if (dto.rollout != null && !(declaration.flag && scope === 'tenant')) {
      issues.push({
        path: 'rollout',
        message: 'Only a flag rolls out, at the tenant scope.',
      });
    }
    let value: unknown = null;
    if (dto.value !== undefined) {
      const parsed = declaration.schema.safeParse(dto.value);
      if (parsed.success) {
        value = parsed.data;
      } else {
        issues.push(
          ...parsed.error.issues.map((issue) => ({
            path: ['value', ...issue.path].join('.'),
            message: issue.message,
          })),
        );
      }
    }
    if (issues.length) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The setting is invalid.',
        errors: issues,
      });
    }
    if (dto.value !== undefined) {
      this.assertAllowed(key, value);
    }
    return this.write(
      actor,
      key,
      scope,
      scopeId,
      value,
      dto.rollout ?? null,
      ip,
    );
  }

  /** Removes a scope's override: back to the next scope's value, or the default. */
  async unset(
    actor: Principal,
    key: string,
    scope: SettingScope,
    scopeId: string | undefined,
    ip?: string,
  ) {
    const declaration = this.declaration(key);
    await this.remove(
      actor,
      key,
      scope,
      await this.scopeId(declaration, scope, scopeId),
      ip,
    );
  }

  /**
   * Sets what holds for every tenant (an operator's, the route checks
   * who): below each tenant's own values, or above them all when
   * `enforced` (a kill switch). Checked against the declaration's schema
   * and the deployment's restrictions. Audited in the operator's tenant;
   * applies everywhere on the next request.
   */
  async setPlatform(
    actor: Principal,
    key: string,
    dto: SetPlatformSettingDto,
    ip?: string,
  ): Promise<PlatformRow> {
    const declaration = this.declaration(key);
    const rollout = dto.rollout ?? null;
    const enforced = dto.enforced ?? false;
    const issues: { path: string; message: string }[] = [];
    if (dto.value === undefined && rollout === null) {
      issues.push({ path: 'value', message: 'A value is required.' });
    }
    if (rollout !== null && !declaration.flag) {
      issues.push({ path: 'rollout', message: 'Only a flag rolls out.' });
    }
    if (enforced && dto.value === undefined) {
      issues.push({
        path: 'enforced',
        message: 'Only a value is enforced, not a rollout.',
      });
    }
    let value: unknown = null;
    if (dto.value !== undefined) {
      const parsed = declaration.schema.safeParse(dto.value);
      if (parsed.success) {
        value = parsed.data;
      } else {
        issues.push(
          ...parsed.error.issues.map((issue) => ({
            path: ['value', ...issue.path].join('.'),
            message: issue.message,
          })),
        );
      }
    }
    if (issues.length) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The setting is invalid.',
        errors: issues,
      });
    }
    if (dto.value !== undefined) {
      this.assertAllowed(key, value);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [before] = await tx
        .select()
        .from(platformSettingValues)
        .where(eq(platformSettingValues.key, key));
      const [after] = await tx
        .insert(platformSettingValues)
        .values({
          key,
          value,
          enforced,
          rollout,
          updatedBy: principalKey(actor),
        })
        .onConflictDoUpdate({
          target: platformSettingValues.key,
          set: { value, enforced, rollout, updatedBy: principalKey(actor) },
        })
        .returning();
      await this.audit.record(
        actor,
        {
          action: 'setting.updated',
          targetType: 'setting',
          targetId: key,
          details: {
            scope: 'platform',
            scopeId: '',
            from: before
              ? {
                  value: before.value,
                  enforced: before.enforced,
                  rollout: before.rollout,
                }
              : null,
            to: { value, enforced, rollout },
          },
          ip,
        },
        tx,
      );
      return after!;
    });
    await this.bumpPlatform();
    return row;
  }

  /** Removes the platform value: each tenant's own, or the default, holds again. */
  async unsetPlatform(actor: Principal, key: string, ip?: string) {
    this.declaration(key);
    const removed = await inTransaction(this.txHost, async (tx) => {
      const [before] = await tx
        .delete(platformSettingValues)
        .where(eq(platformSettingValues.key, key))
        .returning();
      if (before) {
        await this.audit.record(
          actor,
          {
            action: 'setting.reset',
            targetType: 'setting',
            targetId: key,
            details: {
              scope: 'platform',
              scopeId: '',
              from: {
                value: before.value,
                enforced: before.enforced,
                rollout: before.rollout,
              },
            },
            ip,
          },
          tx,
        );
      }
      return before;
    });
    if (removed) await this.bumpPlatform();
  }

  /** A principal's own value of a setting that takes one (`user` among its scopes). */
  async setMine(
    principal: Principal,
    key: string,
    value: unknown,
    ip?: string,
  ) {
    const declaration = this.declaration(key);
    if (!(declaration.scopes ?? []).includes('user')) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'This setting is not set per user.',
        errors: [{ path: 'key', message: 'Not set per user.' }],
      });
    }
    const parsed = declaration.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The value is invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: ['value', ...issue.path].join('.'),
          message: issue.message,
        })),
      });
    }
    this.assertAllowed(key, parsed.data);
    await this.write(
      principal,
      key,
      'user',
      principalKey(principal),
      parsed.data,
      null,
      ip,
    );
    return this.view(declaration, principal);
  }

  async unsetMine(principal: Principal, key: string, ip?: string) {
    const declaration = this.declaration(key);
    await this.remove(principal, key, 'user', principalKey(principal), ip);
    return this.view(declaration, principal);
  }

  /**
   * The scope's id as stored: '' for the tenant; one of its teams; one
   * of its members or API clients (a user is global: a member of the
   * tenant, by its memberships; a team or a client of another tenant is
   * no row, row-level security).
   */
  private async scopeId(
    declaration: SettingDeclaration<any>,
    scope: SettingScope,
    scopeId: string | undefined,
  ) {
    const refuse = (path: string, message: string) => {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The setting is invalid.',
        errors: [{ path, message }],
      });
    };
    if (!(declaration.scopes ?? ['tenant']).includes(scope)) {
      refuse('scope', `"${declaration.key}" is not set per ${scope}.`);
    }
    if (scope === 'tenant') {
      return '';
    }
    if (!scopeId) {
      refuse('scopeId', `Required for the ${scope} scope.`);
    }
    if (scope === 'team') {
      const [team] = await this.db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, scopeId!));
      if (!team) throw new NotFoundException(`Team ${scopeId} not found.`);
      return team.id;
    }
    const [kind, id] = scopeId!.split(':') as [string, string | undefined];
    const found =
      kind === 'user' && id && UUID.test(id)
        ? await this.db
            .select({ id: memberships.userId })
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, id),
                eq(memberships.tenantId, requireTenantId('A setting')),
              ),
            )
        : kind === 'client' && id && UUID.test(id)
          ? await this.db
              .select({ id: apiClients.id })
              .from(apiClients)
              .where(eq(apiClients.id, id))
          : [];
    if (found.length === 0) {
      throw new NotFoundException(`Principal ${scopeId} not found.`);
    }
    return scopeId!;
  }

  private async write(
    actor: Principal,
    key: string,
    scope: SettingScope,
    scopeId: string,
    value: unknown,
    rollout: number | null,
    ip?: string,
  ) {
    const row = await inTransaction(this.txHost, async (tx) => {
      const [before] = await tx
        .select()
        .from(settingOverrides)
        .where(
          and(
            eq(settingOverrides.key, key),
            eq(settingOverrides.scope, scope),
            eq(settingOverrides.scopeId, scopeId),
          ),
        );
      const [after] = await tx
        .insert(settingOverrides)
        .values({
          key,
          scope,
          scopeId,
          value,
          rollout,
          updatedBy: principalKey(actor),
        })
        .onConflictDoUpdate({
          target: [
            settingOverrides.tenantId,
            settingOverrides.key,
            settingOverrides.scope,
            settingOverrides.scopeId,
          ],
          set: { value, rollout, updatedBy: principalKey(actor) },
        })
        .returning();
      await this.audit.record(
        actor,
        {
          action: 'setting.updated',
          targetType: 'setting',
          targetId: key,
          details: {
            scope,
            scopeId,
            from: before
              ? { value: before.value, rollout: before.rollout }
              : null,
            to: { value, rollout },
          },
          ip,
        },
        tx,
      );
      return after!;
    });
    await this.bump();
    return row;
  }

  private async remove(
    actor: Principal,
    key: string,
    scope: SettingScope,
    scopeId: string,
    ip?: string,
  ) {
    const removed = await inTransaction(this.txHost, async (tx) => {
      const [before] = await tx
        .delete(settingOverrides)
        .where(
          and(
            eq(settingOverrides.key, key),
            eq(settingOverrides.scope, scope),
            eq(settingOverrides.scopeId, scopeId),
          ),
        )
        .returning();
      if (before) {
        await this.audit.record(
          actor,
          {
            action: 'setting.reset',
            targetType: 'setting',
            targetId: key,
            details: {
              scope,
              scopeId,
              from: { value: before.value, rollout: before.rollout },
            },
            ip,
          },
          tx,
        );
      }
      return before;
    });
    if (removed) await this.bump();
  }

  private async teamsOf(userId: string) {
    const rows = await this.db
      .select({ id: userTeams.teamId })
      .from(userTeams)
      .where(eq(userTeams.userId, userId));
    return rows.map((row) => row.id);
  }

  /** After a commit: this instance forgets the tenant's cache, the others see a new version. */
  private async bump() {
    const tenantId = requireTenantId('A setting');
    this.caches.delete(tenantId);
    await this.redis
      .incr(tenantKey(SettingsService.VERSION_KEY, tenantId))
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not publish a settings change; other instances see it within ${SettingsService.FALLBACK_TTL_MS} ms.`,
          { error: String(error) },
        ),
      );
  }

  /** After a commit: this instance forgets the platform values, the others see a new version. */
  private async bumpPlatform() {
    this.platformCache = undefined;
    await this.redis
      .incr(SettingsService.PLATFORM_VERSION_KEY)
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not publish a platform settings change; other instances see it within ${SettingsService.FALLBACK_TTL_MS} ms.`,
          { error: String(error) },
        ),
      );
  }

  /** The operators' value of a setting for every tenant, if any. */
  private async platformValue(
    key: string,
  ): Promise<PlatformSettingValue | undefined> {
    const row = (await this.loadPlatform()).byKey.get(key);
    return row
      ? { value: row.value, enforced: row.enforced, rollout: row.rollout }
      : undefined;
  }

  /** The platform values (a global table), cached like a tenant's. */
  private async loadPlatform(): Promise<CachedPlatform> {
    const version = await this.redisGet(SettingsService.PLATFORM_VERSION_KEY);
    const cached = this.platformCache;
    if (cached && this.fresh(cached, version)) {
      return cached;
    }
    const rows = await this.db.select().from(platformSettingValues);
    const entry: CachedPlatform = {
      version,
      loadedAt: Date.now(),
      byKey: new Map(rows.map((row) => [row.key, row])),
    };
    this.platformCache = entry;
    return entry;
  }

  /** Whether a cache entry still holds: its version is current, or, Redis away, it is young. */
  private fresh(
    cached: { version: string | undefined; loadedAt: number },
    version: string | undefined,
  ) {
    const age = Date.now() - cached.loadedAt;
    return (
      age < SettingsService.MAX_AGE_MS &&
      (version !== undefined && cached.version !== undefined
        ? cached.version === version
        : age < SettingsService.FALLBACK_TTL_MS)
    );
  }

  private async redisGet(key: string): Promise<string | undefined> {
    try {
      return (await this.redis.get(key)) ?? '0';
    } catch {
      return undefined; // Redis away: fall back to a short TTL
    }
  }

  private version(tenantId: string): Promise<string | undefined> {
    return this.redisGet(tenantKey(SettingsService.VERSION_KEY, tenantId));
  }

  /** The current tenant's overrides (none outside a tenant). */
  private async load(): Promise<Cached> {
    const tenantId = currentTenantId();
    if (!tenantId) {
      return NOTHING;
    }
    const version = await this.version(tenantId);
    const cached = this.caches.get(tenantId);
    if (cached && this.fresh(cached, version)) {
      return cached;
    }
    const rows = await this.db.select().from(settingOverrides);
    const byKey = new Map<string, Row[]>();
    for (const row of rows) {
      const list = byKey.get(row.key) ?? [];
      list.push(row);
      byKey.set(row.key, list);
    }
    const entry: Cached = { version, loadedAt: Date.now(), byKey };
    this.caches.delete(tenantId);
    this.caches.set(tenantId, entry);
    if (this.caches.size > SettingsService.MAX_CACHED_TENANTS) {
      this.caches.delete(this.caches.keys().next().value!);
    }
    return entry;
  }
}

export type { SettingOverride };
