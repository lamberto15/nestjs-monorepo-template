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
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  apiClients,
  orgUnits,
  userOrgUnits,
  users,
} from '../../iam/iam.tables.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { resolveSetting, type SettingSource } from './setting-resolution.js';
import type { SetSettingDto } from './setting.schemas.js';
import type {
  SettingDeclaration,
  SettingOverride,
  SettingScope,
} from './setting.types.js';
import { settingOverrides } from './settings.tables.js';

/** A setting as a caller sees it. */
export interface SettingView {
  key: string;
  label: string;
  description: string | null;
  flag: boolean;
  scopes: readonly SettingScope[];
  public: boolean;
  value: unknown;
  source: SettingSource;
  default: unknown;
}

type Row = typeof settingOverrides.$inferSelect;

interface Cached {
  version: string | undefined;
  loadedAt: number;
  byKey: Map<string, Row[]>;
}

/**
 * Settings and feature flags: the declarations are code
 * (`PlatformModule.forRoot({ settings })`), the values administrators and
 * users set are rows, read through one cache per instance. Every change
 * increments `settings:version` in Redis after its commit; each read
 * compares it with the cached one, so a change applies on the next
 * request everywhere (as custom fields do). Without Redis the cache
 * holds for FALLBACK_TTL_MS at most.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');
  private readonly byKey = new Map<string, SettingDeclaration<any>>();
  private cache?: Cached;
  private static readonly VERSION_KEY = 'settings:version';
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
    const units =
      principal?.kind === 'user' &&
      (declaration.scopes ?? []).includes('orgUnit') &&
      overrides.some((override) => override.scope === 'orgUnit')
        ? await this.unitsOf(principal.id)
        : [];
    return resolveSetting(declaration, overrides, principal, units);
  }

  /** Every setting the caller may see, with their value for them. */
  async effective(principal: Principal, { all = false } = {}) {
    const views: SettingView[] = [];
    for (const declaration of this.byKey.values()) {
      if (declaration.public === false && !all) continue;
      views.push(await this.view(declaration, principal));
    }
    return views;
  }

  async view(
    declaration: SettingDeclaration<any>,
    principal: Principal,
  ): Promise<SettingView> {
    const { value, source } = await this.resolve(declaration, principal);
    return {
      key: declaration.key,
      label: declaration.label,
      description: declaration.description ?? null,
      flag: declaration.flag === true,
      scopes: declaration.scopes ?? ['global'],
      public: declaration.public !== false,
      value,
      source,
      default: declaration.default,
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
   * must pass its schema, a rollout is for flags at the global scope.
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
    if (dto.rollout != null && !(declaration.flag && scope === 'global')) {
      issues.push({
        path: 'rollout',
        message: 'Only a flag rolls out, at the global scope.',
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

  /** The scope's id as stored: '' for global; an existing org unit; an existing user or client. */
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
    if (!(declaration.scopes ?? ['global']).includes(scope)) {
      refuse('scope', `"${declaration.key}" is not set per ${scope}.`);
    }
    if (scope === 'global') {
      return '';
    }
    if (!scopeId) {
      refuse('scopeId', `Required for the ${scope} scope.`);
    }
    if (scope === 'orgUnit') {
      const [unit] = await this.db
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(eq(orgUnits.id, scopeId!));
      if (!unit) throw new NotFoundException(`Org unit ${scopeId} not found.`);
      return unit.id;
    }
    const [kind, id] = scopeId!.split(':') as [string, string | undefined];
    const found =
      kind === 'user' && id
        ? await this.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, id))
        : kind === 'client' && id
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

  private async unitsOf(userId: string) {
    const rows = await this.db
      .select({ id: userOrgUnits.orgUnitId })
      .from(userOrgUnits)
      .where(eq(userOrgUnits.userId, userId));
    return rows.map((row) => row.id);
  }

  /** After a commit: this instance forgets its cache, the others see a new version. */
  private async bump() {
    this.cache = undefined;
    await this.redis
      .incr(SettingsService.VERSION_KEY)
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not publish a settings change; other instances see it within ${SettingsService.FALLBACK_TTL_MS} ms.`,
          { error: String(error) },
        ),
      );
  }

  private async version(): Promise<string | undefined> {
    try {
      return (await this.redis.get(SettingsService.VERSION_KEY)) ?? '0';
    } catch {
      return undefined; // Redis away: fall back to a short TTL
    }
  }

  private async load(): Promise<Cached> {
    const version = await this.version();
    const cached = this.cache;
    const age = cached ? Date.now() - cached.loadedAt : Infinity;
    if (
      cached &&
      age < SettingsService.MAX_AGE_MS &&
      (version !== undefined && cached.version !== undefined
        ? cached.version === version
        : age < SettingsService.FALLBACK_TTL_MS)
    ) {
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
    this.cache = entry;
    return entry;
  }
}

export type { SettingOverride };
