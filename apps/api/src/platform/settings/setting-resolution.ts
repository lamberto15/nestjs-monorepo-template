import { createHash } from 'node:crypto';
import type { Principal } from '../../iam/auth/principal.js';
import { principalKey } from '../../iam/auth/principal.js';
import {
  type FlagRule,
  ruleMatches,
  type RuleAttributes,
} from './setting-rules.js';
import type {
  PlatformSettingValue,
  SettingDeclaration,
  SettingOverride,
  SettingScope,
} from './setting.types.js';

/**
 * How a setting's value is found for a principal: pure functions, so the
 * order of precedence can be read and tested apart from the service.
 *
 * An operator's enforced platform value → principal's own → one of their
 * teams' → the tenant's (or its rollout) → the operator's platform value
 * (or its rollout, drawn the same way in each tenant) → default. A
 * flag's rows may carry targeting rules (setting-rules.ts), evaluated
 * before the scope's plain value: the first rule whose conditions hold
 * decides (`source: 'rule'`). A flag's tenant row may carry no value but a rollout percentage: then it
 * is on for a stable share of the tenant's principals (the same principal
 * always gets the same answer in a tenant, and a higher percentage never
 * switches anyone off). The share is drawn with the tenant in the hash, so
 * each tenant's rollout picks its own principals, and a person in two
 * tenants is drawn in each apart.
 */

export type SettingSource =
  SettingScope | 'rule' | 'rollout' | 'platform' | 'default';

/** A principal's share, 0–99, stable per setting, tenant and principal. */
export function rolloutBucket(
  key: string,
  tenantId: string,
  principal: string,
) {
  const digest = createHash('sha256')
    .update(`${key}:${tenantId}:${principal}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * The outcome of the first rule that matches, or undefined. A rollout
 * outcome draws inside the matched group, stably per principal. Without
 * attributes (no principal) no rule matches: fail closed.
 */
function applyRules(
  declaration: SettingDeclaration<any>,
  rules: readonly FlagRule[] | undefined,
  attributes: RuleAttributes | null | undefined,
  principal: Pick<Principal, 'kind' | 'id'> | null,
  tenantId: string | null,
): boolean | undefined {
  if (!declaration.flag || !rules?.length || !attributes || !principal) {
    return undefined;
  }
  const rule = rules.find((candidate) => ruleMatches(candidate, attributes));
  if (!rule) {
    return undefined;
  }
  return 'value' in rule.outcome
    ? rule.outcome.value
    : rolloutBucket(declaration.key, tenantId ?? '', principalKey(principal)) <
        rule.outcome.rollout;
}

/**
 * The effective value of `declaration` for `principal` (none: the
 * tenant's value) in `tenantId`, given the tenant's stored overrides of
 * its key and the ids of the teams the principal belongs to. Without
 * a tenant there are no overrides: the platform value, else the default.
 * `platform` is what an operator set for every tenant, if anything.
 */
export function resolveSetting<T>(
  declaration: SettingDeclaration<T>,
  overrides: readonly SettingOverride[],
  principal: Pick<Principal, 'kind' | 'id'> | null,
  teamIds: readonly string[],
  tenantId: string | null,
  platform?: PlatformSettingValue,
  attributes?: RuleAttributes | null,
): { value: T; source: SettingSource } {
  if (platform?.enforced && platform.value !== null) {
    return { value: platform.value as T, source: 'platform' };
  }
  const scopes = declaration.scopes ?? ['tenant'];
  const find = (scope: SettingScope, scopeId: string) =>
    overrides.find(
      (override) => override.scope === scope && override.scopeId === scopeId,
    );
  if (principal && scopes.includes('user')) {
    const own = find('user', principalKey(principal));
    if (own && own.value !== null) {
      return { value: own.value as T, source: 'user' };
    }
  }
  if (principal && scopes.includes('team')) {
    for (const teamId of teamIds) {
      const team = find('team', teamId);
      if (team && team.value !== null) {
        return { value: team.value as T, source: 'team' };
      }
    }
  }
  const tenant = find('tenant', '');
  const byTenantRule = applyRules(
    declaration,
    tenant?.rules,
    attributes,
    principal,
    tenantId,
  );
  if (byTenantRule !== undefined) {
    return { value: byTenantRule as T, source: 'rule' };
  }
  if (tenant && tenant.value !== null) {
    return { value: tenant.value as T, source: 'tenant' };
  }
  if (declaration.flag && tenant?.rollout != null && principal && tenantId) {
    return {
      value: (rolloutBucket(
        declaration.key,
        tenantId,
        principalKey(principal),
      ) < tenant.rollout) as T,
      source: 'rollout',
    };
  }
  const byPlatformRule = applyRules(
    declaration,
    platform?.rules,
    attributes,
    principal,
    tenantId,
  );
  if (byPlatformRule !== undefined) {
    return { value: byPlatformRule as T, source: 'rule' };
  }
  if (platform && platform.value !== null) {
    return { value: platform.value as T, source: 'platform' };
  }
  if (declaration.flag && platform?.rollout != null && principal) {
    return {
      value: (rolloutBucket(
        declaration.key,
        tenantId ?? '',
        principalKey(principal),
      ) < platform.rollout) as T,
      source: 'platform',
    };
  }
  return { value: declaration.default, source: 'default' };
}
