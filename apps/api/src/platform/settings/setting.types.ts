import { z } from 'zod';

/**
 * Where a setting's value may be set: for the whole tenant, for an org
 * team's users, or per principal. Every value is a tenant's (rows under
 * row-level security, docs/tenancy.md); what holds for every tenant is the
 * declaration's default, in code.
 */
export const SETTING_SCOPES = ['tenant', 'team', 'user'] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

/**
 * A setting a feature declares (`defineSettings()`), handed to the
 * platform in `app.module.ts`: a typed value with a default, that
 * administrators change at runtime (`PUT /settings/{key}`), for their
 * tenant or for a team, and that users may set for themselves when `user`
 * is among its scopes (a preference).
 *
 * ```ts
 * export const NOTE_PUBLISH_DELAY = setting({ key: 'notes.publishDelay', label: 'Publication delay', schema: duration, default: '10s' });
 * export const NOTE_SETTINGS = defineSettings([NOTE_PUBLISH_DELAY, NOTE_RICH_TEXT]);
 * PlatformModule.forRoot({ …, settings: [...NOTE_SETTINGS] })
 * // in a service
 * const delay = await this.settings.get(NOTE_PUBLISH_DELAY);
 * ```
 */
export interface SettingDeclaration<T = unknown> {
  /** Dotted, the feature first: `notes.publishDelay`. */
  key: string;
  label: string;
  description?: string;
  schema: z.ZodType<T>;
  default: T;
  /** Where it may be overridden; default `['tenant']`. */
  scopes?: readonly SettingScope[];
  /** Shown to every caller by GET /settings (default), or only to those who manage settings. */
  public?: boolean;
  /** A feature flag: a boolean that can also roll out to a percentage of principals. */
  flag?: boolean;
}

export const setting = <const T>(declaration: SettingDeclaration<T>) =>
  declaration;

/**
 * A feature flag: on or off, with a default, that administrators switch
 * at runtime, for their tenant, a team or one principal, or roll out
 * to a stable percentage of the tenant's principals (`PUT /settings/{key}
 * { rollout: 20 }`), drawn apart in each tenant.
 * Read it with `settings.enabled(FLAG, principal)`.
 */
export const flag = (
  declaration: Omit<SettingDeclaration<boolean>, 'schema' | 'flag'>,
): SettingDeclaration<boolean> => ({
  scopes: ['tenant', 'team', 'user'],
  ...declaration,
  schema: z.boolean(),
  flag: true,
});

export const defineSettings = <
  const T extends readonly SettingDeclaration<any>[],
>(
  settings: T,
) => settings;

/**
 * A value an operator set for every tenant (`PUT /settings/{key}/platform`):
 * the runtime default, below each tenant's own values, or, `enforced`,
 * above all of them (a kill switch). Stored in a global table.
 */
export interface PlatformSettingValue {
  /** Null: only `rollout` applies (a flag). */
  value: unknown;
  enforced: boolean;
  /** Flags: the percentage of each tenant's principals it is on for, when no value is set. */
  rollout: number | null;
}

/** A stored override: one scope's value of a setting (and a flag's rollout at the tenant scope). */
export interface SettingOverride {
  key: string;
  scope: SettingScope;
  /** The team's id, the principal's key (`user:<id>`), or `''` for the tenant. */
  scopeId: string;
  value: unknown;
  /** Flags, tenant scope: the percentage of the tenant's principals it is on for, when no value is set. */
  rollout: number | null;
}
