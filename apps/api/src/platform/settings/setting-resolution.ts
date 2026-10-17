import { createHash } from 'node:crypto';
import type { Principal } from '../../iam/auth/principal.js';
import { principalKey } from '../../iam/auth/principal.js';
import type {
  SettingDeclaration,
  SettingOverride,
  SettingScope,
} from './setting.types.js';

/**
 * How a setting's value is found for a principal: pure functions, so the
 * order of precedence can be read and tested apart from the service.
 *
 * principal's own → one of their org units' → the tenant's → default. A
 * flag's tenant row may carry no value but a rollout percentage: then it
 * is on for a stable share of the tenant's principals (the same principal
 * always gets the same answer in a tenant, and a higher percentage never
 * switches anyone off). The share is drawn with the tenant in the hash, so
 * each tenant's rollout picks its own principals, and a person in two
 * tenants is drawn in each apart.
 */

export type SettingSource = SettingScope | 'rollout' | 'default';

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
 * its key and the ids of the org units the principal belongs to. Without
 * a tenant there are no overrides: the default.
 */
export function resolveSetting<T>(
  declaration: SettingDeclaration<T>,
  overrides: readonly SettingOverride[],
  principal: Pick<Principal, 'kind' | 'id'> | null,
  orgUnitIds: readonly string[],
  tenantId: string | null,
): { value: T; source: SettingSource } {
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
  if (principal && scopes.includes('orgUnit')) {
    for (const unitId of orgUnitIds) {
      const unit = find('orgUnit', unitId);
      if (unit && unit.value !== null) {
        return { value: unit.value as T, source: 'orgUnit' };
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
  return { value: declaration.default, source: 'default' };
}
