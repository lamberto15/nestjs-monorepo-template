import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  inTransaction,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { AccessAdminService } from '../../iam/access/access-admin.service.js';
import { PermissionCatalog } from '../../iam/access/permission-catalog.js';
import { isAll } from '../../iam/access/permissions.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { parseRules, type FlagRule } from '../settings/setting-rules.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  type BundleContents,
  CONFIG_BUNDLE_VERSION,
  type ConfigBundle,
  type ConfigPreview,
} from './config-bundle.schemas.js';

type Rule = Record<string, unknown>;
type Change = ConfigPreview['changes'][number];
type Issue = ConfigPreview['errors'][number];

/** JSON with every object's keys sorted: the same contents, the same text, the same checksum. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      // Code-unit order, not the locale's: the checksum must not depend on where it runs.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .filter((key) => (value as Rule)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Rule)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const checksumOf = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Promoting configuration between environments (docs/settings.md,
 * "Promoting configuration"): a tenant's settings (its tenant-scope values,
 * flags' rollouts and rules) and custom roles, exported as a checksummed
 * bundle, previewed against another tenant (a diff and the validation the
 * target's own declarations make), then applied there in one transaction.
 *
 * - Stable references: settings by key, roles by name; a flag rule's role
 *   condition carries role names, mapped to the target's role ids. An id of
 *   any other record (an organizational unit in a condition) is applied as
 *   is and reported as a warning.
 * - Nothing secret: settings hold no credentials, roles hold permissions;
 *   unit and user values (this environment's people and units), the
 *   built-in roles, users, grants, API clients and records stay out.
 * - Additive: what the target has and the bundle lacks stays.
 * - Version conflicts: the preview answers `targetVersion`, a checksum of
 *   what the target holds for what the bundle touches; apply refuses with
 *   409 `config_changed` when it moved since. A newer bundle format, a
 *   damaged checksum, an unknown setting (a feature not deployed here) or a
 *   value the target refuses stops the whole bundle: nothing is applied.
 */
@Injectable()
export class ConfigBundlesService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly settings: SettingsService,
    private readonly accessAdmin: AccessAdminService,
    private readonly catalog: PermissionCatalog,
    private readonly audit: AuditService,
  ) {}

  /** This tenant's configuration as a bundle. */
  async export(): Promise<ConfigBundle> {
    const contents = await this.current();
    return {
      format: 'config-bundle',
      version: CONFIG_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      checksum: checksumOf(contents),
      contents,
    };
  }

  /** What applying the bundle here would do, and whether it may. Changes nothing. */
  async preview(bundle: ConfigBundle): Promise<ConfigPreview> {
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    if (bundle.version > CONFIG_BUNDLE_VERSION) {
      errors.push({
        ref: null,
        message: `Bundle format ${bundle.version} is newer than this deployment reads (${CONFIG_BUNDLE_VERSION}): upgrade it first.`,
      });
    }
    if (checksumOf(bundle.contents) !== bundle.checksum) {
      errors.push({
        ref: null,
        message:
          'The checksum does not match the contents: the bundle was changed or damaged after export.',
      });
    }
    const target = await this.current();
    const { settings, roles } = bundle.contents;
    const roleNames = new Set([
      ...target.roles.map((role) => role.name),
      ...roles.map((role) => role.name),
    ]);
    const systemRoles = new Set(
      (await this.accessAdmin.listRoles())
        .filter((role) => role.system)
        .map((role) => role.name),
    );
    const changes: Change[] = [];
    for (const role of roles) {
      if (systemRoles.has(role.name)) {
        errors.push({
          ref: role.name,
          message: 'A built-in role of the target: it is never changed.',
        });
        continue;
      }
      for (const permission of role.permissions) {
        if (isAll(permission)) continue;
        const result = this.catalog.validate(permission);
        if (!result.ok) {
          errors.push({ ref: role.name, message: result.error });
        } else if (
          permission.conditions.some((condition) =>
            UUID.test(JSON.stringify(condition.params ?? {})),
          )
        ) {
          warnings.push({
            ref: role.name,
            message: `${permission.subject}.${permission.action}: a condition names a record of the source environment by id; check it after applying.`,
          });
        }
      }
      const existing = target.roles.find((own) => own.name === role.name);
      changes.push({
        type: 'role',
        ref: role.name,
        action: !existing
          ? 'create'
          : canonicalJson(existing) === canonicalJson(role)
            ? 'unchanged'
            : 'update',
      });
    }
    for (const setting of settings) {
      const issues = this.checkSetting(setting, roleNames);
      errors.push(...issues.map((message) => ({ ref: setting.key, message })));
      const existing = target.settings.find((own) => own.key === setting.key);
      changes.push({
        type: 'setting',
        ref: setting.key,
        action: !existing
          ? 'create'
          : canonicalJson(existing) === canonicalJson(setting)
            ? 'unchanged'
            : 'update',
      });
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      changes,
      targetVersion: checksumOf(this.touched(target, bundle.contents)),
    };
  }

  /**
   * Applies a previewed bundle: roles first (a flag rule may name one),
   * then settings, through the services' own writes (their checks, locks
   * and audit entries), in one transaction: one failure and nothing stays.
   * One `config-bundle.applied` audit entry sums it up.
   */
  async apply(
    actor: UserPrincipal,
    bundle: ConfigBundle,
    targetVersion: string,
    ip?: string,
  ) {
    return inTransaction(this.txHost, async (tx) => {
      const preview = await this.preview(bundle);
      if (preview.targetVersion !== targetVersion) {
        throw new ConflictException({
          code: 'config_changed',
          message:
            'The target changed since the preview: preview the bundle again.',
        });
      }
      if (!preview.valid) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: 'The bundle is invalid here.',
          errors: preview.errors.map((issue) => ({
            path: issue.ref ?? 'bundle',
            message: issue.message,
          })),
        });
      }
      const action = (type: Change['type'], ref: string) =>
        preview.changes.find((c) => c.type === type && c.ref === ref)!.action;
      const existingRoles = await this.accessAdmin.listRoles();
      for (const role of bundle.contents.roles) {
        const input = {
          name: role.name,
          description: role.description,
          permissions: role.permissions,
        };
        const existing = existingRoles.find((own) => own.name === role.name);
        if (!existing) {
          await this.accessAdmin.createRole(actor, input, ip);
        } else if (action('role', role.name) === 'update') {
          await this.accessAdmin.updateRole(actor, existing.id, input, ip);
        }
      }
      const roleIds = new Map(
        (await this.accessAdmin.listRoles()).map((role) => [
          role.name,
          role.id,
        ]),
      );
      for (const setting of bundle.contents.settings) {
        if (action('setting', setting.key) === 'unchanged') continue;
        await this.settings.set(
          actor,
          setting.key,
          {
            scope: 'tenant',
            ...(setting.value !== null && { value: setting.value }),
            rollout: setting.rollout,
            rules: rulesIn(setting.rules, roleIds) as unknown as FlagRule[],
          },
          ip,
        );
      }
      const count = (wanted: Change['action']) =>
        preview.changes.filter((change) => change.action === wanted).length;
      const counts = {
        created: count('create'),
        updated: count('update'),
        unchanged: count('unchanged'),
      };
      await this.audit.record(
        actor,
        {
          action: 'config-bundle.applied',
          details: {
            checksum: bundle.checksum,
            exportedAt: bundle.exportedAt,
            ...counts,
          },
          ip,
        },
        tx,
      );
      return counts;
    });
  }

  /** The tenant's settings (tenant scope) and custom roles, as a bundle's contents. */
  private async current(): Promise<BundleContents> {
    const roles = (await this.accessAdmin.listRoles()).filter(
      (role) => !role.system,
    );
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const settings: BundleContents['settings'] = [];
    for (const declaration of this.settings.declarations()) {
      const row = (await this.settings.overrides(declaration.key)).find(
        (override) => override.scope === 'tenant',
      );
      if (row) {
        settings.push({
          key: declaration.key,
          value: row.value ?? null,
          rollout: row.rollout ?? null,
          rules: rulesOut((row.rules ?? []) as unknown as Rule[], roleNames),
        });
      }
    }
    return {
      settings: settings.sort((a, b) => a.key.localeCompare(b.key)),
      roles: roles
        .map((role) => ({
          name: role.name,
          description: role.description,
          permissions: role.permissions,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** What the target holds for the keys and names the bundle touches: the version apply compares. */
  private touched(target: BundleContents, bundle: BundleContents) {
    const keys = new Set(bundle.settings.map((setting) => setting.key));
    const names = new Set(bundle.roles.map((role) => role.name));
    return {
      settings: target.settings.filter((setting) => keys.has(setting.key)),
      roles: target.roles.filter((role) => names.has(role.name)),
    };
  }

  /** The target's declaration takes the setting: declared, its value, a rollout or rules only on a flag. */
  private checkSetting(
    setting: BundleContents['settings'][number],
    roleNames: ReadonlySet<string>,
  ): string[] {
    const declaration = this.settings
      .declarations()
      .find((declared) => declared.key === setting.key);
    if (!declaration) {
      return [
        'Not declared here: the feature that declares it is not deployed or is switched off.',
      ];
    }
    if (!(declaration.scopes ?? ['tenant']).includes('tenant')) {
      return ['Not set for a whole tenant here.'];
    }
    const issues: string[] = [];
    if (setting.value !== null) {
      const parsed = declaration.schema.safeParse(setting.value);
      if (!parsed.success) {
        issues.push(
          `The value is refused here: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }
    }
    if (
      !declaration.flag &&
      (setting.rollout !== null || setting.rules.length > 0)
    ) {
      issues.push('A rollout or rules, but it is not a flag here.');
    }
    const missing = roleNamesIn(setting.rules).filter(
      (name) => !roleNames.has(name),
    );
    if (missing.length) {
      issues.push(
        `No such role here, nor in the bundle: ${missing.join(', ')}.`,
      );
    }
    if (setting.rules.length) {
      // Checked with placeholder ids: the names are what the target maps.
      const parsed = parseRules(
        rulesIn(
          setting.rules,
          new Map(
            roleNamesIn(setting.rules).map((name) => [name, PLACEHOLDER_ID]),
          ),
        ),
        'tenant',
      );
      if (!parsed.ok) {
        issues.push(...parsed.issues.map((issue) => issue.message));
      }
    }
    return issues;
  }
}

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

const isRoleCondition = (condition: unknown): condition is Rule =>
  !!condition && (condition as Rule).key === 'role';

const conditionsOf = (rule: Rule) =>
  Array.isArray(rule.conditions) ? (rule.conditions as unknown[]) : [];

/** A rule's role ids as role names (export). */
function rulesOut(rules: Rule[], names: ReadonlyMap<string, string>): Rule[] {
  return rules.map((rule) => ({
    ...rule,
    conditions: conditionsOf(rule).map((condition) => {
      if (!isRoleCondition(condition)) return condition;
      const params = (condition.params ?? {}) as { roleIds?: string[] };
      return {
        key: 'role',
        params: {
          roleNames: (params.roleIds ?? []).map((id) => names.get(id) ?? id),
        },
      };
    }),
  }));
}

/** A rule's role names as this tenant's role ids (apply). */
function rulesIn(rules: Rule[], ids: ReadonlyMap<string, string>): Rule[] {
  return rules.map((rule) => ({
    ...rule,
    conditions: conditionsOf(rule).map((condition) => {
      if (!isRoleCondition(condition)) return condition;
      const params = (condition.params ?? {}) as { roleNames?: string[] };
      return {
        key: 'role',
        params: {
          roleIds: (params.roleNames ?? []).map(
            (name) => ids.get(name) ?? name,
          ),
        },
      };
    }),
  }));
}

const roleNamesIn = (rules: Rule[]) =>
  rules.flatMap((rule) =>
    conditionsOf(rule)
      .filter(isRoleCondition)
      .flatMap(
        (condition) =>
          ((condition.params ?? {}) as { roleNames?: string[] }).roleNames ??
          [],
      ),
  );
