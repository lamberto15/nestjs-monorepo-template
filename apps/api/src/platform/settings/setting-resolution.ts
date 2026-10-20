import { createHash } from 'node:crypto';
import type { Principal } from '../../iam/auth/principal.js';
import { principalKey } from '../../iam/auth/principal.js';
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
 * flag's tenant row may carry no value but a rollout percentage: then it
 * is on for a stable share of the tenant's principals (the same principal
 * always gets the same answer in a tenant, and a higher percentage never
 * switches anyone off). The share is drawn with the tenant in the hash, so
 * each tenant's rollout picks its own principals, and a person in two
 * tenants is drawn in each apart.
 */

export type SettingSource = SettingScope | 'rollout' | 'platform' | 'default';

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
