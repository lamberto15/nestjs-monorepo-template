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
 * principal's own → one of their org units' → global → default. A flag's
 * global row may carry no value but a rollout percentage: then it is on
 * for a stable share of principals (the same principal always gets the
 * same answer, and a higher percentage never switches anyone off).
 */

export type SettingSource = SettingScope | 'rollout' | 'default';

/** A principal's share, 0–99, stable per setting and principal. */
export function rolloutBucket(key: string, principal: string) {
  const digest = createHash('sha256').update(`${key}:${principal}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * The effective value of `declaration` for `principal` (none: the
 * global value), given the stored overrides of its key and the ids of
 * the org units the principal belongs to.
 */
export function resolveSetting<T>(
  declaration: SettingDeclaration<T>,
  overrides: readonly SettingOverride[],
  principal: Pick<Principal, 'kind' | 'id'> | null,
  orgUnitIds: readonly string[],
): { value: T; source: SettingSource } {
  const scopes = declaration.scopes ?? ['global'];
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
  const global = find('global', '');
  if (global && global.value !== null) {
    return { value: global.value as T, source: 'global' };
  }
  if (declaration.flag && global?.rollout != null && principal) {
    return {
      value: (rolloutBucket(declaration.key, principalKey(principal)) <
        global.rollout) as T,
      source: 'rollout',
    };
  }
  return { value: declaration.default, source: 'default' };
}
