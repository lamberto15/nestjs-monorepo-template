import { z } from 'zod';
import { SETTING_SCOPES } from './setting.types.js';

/** A declared key: `notes.publishDelay`. */
export const settingKey = z
  .string()
  .regex(
    /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/,
    'a dotted key: feature.name',
  )
  .max(100)
  .meta({ example: 'notes.publishDelay' });

/** A setting as a caller sees it: its effective value for them, and where it came from. */
export const settingViewSchema = z.object({
  key: settingKey,
  label: z.string(),
  description: z.string().nullable(),
  flag: z
    .boolean()
    .describe(
      'A feature flag (boolean, may roll out to a share of principals).',
    ),
  scopes: z
    .array(z.enum(SETTING_SCOPES))
    .describe('Where it may be set; `user`: you may set it for yourself.'),
  public: z.boolean(),
  value: z.unknown(),
  source: z
    .enum([...SETTING_SCOPES, 'rollout', 'default'])
    .describe('Where your value comes from.'),
  default: z.unknown(),
});

/** A stored override, for those who manage settings. */
export const settingOverrideSchema = z.object({
  key: settingKey,
  scope: z.enum(SETTING_SCOPES),
  scopeId: z
    .string()
    .describe(
      "The org unit's id, the principal's key (`user:<id>`), or '' for the tenant.",
    ),
  value: z.unknown(),
  rollout: z.int().min(0).max(100).nullable(),
  updatedBy: z.string(),
  updatedAt: z.iso.datetime(),
});

export const setSettingSchema = z
  .object({
    scope: z.enum(SETTING_SCOPES).default('tenant'),
    scopeId: z
      .string()
      .max(100)
      .optional()
      .describe(
        "For orgUnit: the unit's id; for user: the principal's key (`user:<id>`, `client:<id>`).",
      ),
    value: z
      .unknown()
      .optional()
      .describe(
        "The value; left out with `rollout`: the flag's rollout alone applies.",
      ),
    rollout: z
      .int()
      .min(0)
      .max(100)
      .nullable()
      .optional()
      .describe(
        "Flags, tenant scope: the percentage of the tenant's principals the flag is on for.",
      ),
  })
  .strict();
export type SetSettingDto = z.infer<typeof setSettingSchema>;

export const unsetSettingQuerySchema = z
  .object({
    scope: z.enum(SETTING_SCOPES).default('tenant'),
    scopeId: z.string().max(100).optional(),
  })
  .strict();

export const setMineSchema = z.object({ value: z.unknown() }).strict();
