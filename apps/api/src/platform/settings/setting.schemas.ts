import { z } from 'zod';
import { SETTING_VALUE_TYPES } from './setting-value-schema.js';
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
  type: z
    .enum(SETTING_VALUE_TYPES)
    .describe(
      "The value's kind, from the declaration's schema: the input to show. `json`: anything else (an object, a union); `schema` says what.",
    ),
  options: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe('`enum`: the values it takes.'),
  min: z.number().optional().describe('`number`: the smallest it takes.'),
  max: z.number().optional().describe('`number`: the largest it takes.'),
  integer: z.boolean().optional().describe('`number`: whole numbers only.'),
  maxLength: z
    .int()
    .optional()
    .describe('`string`: the most characters it takes.'),
  schema: z
    .record(z.string(), z.unknown())
    .describe(
      "The value's JSON Schema (draft 2020-12), generated from the declaration: patterns, exclusive bounds, an object's shape. What it can't express (a refinement) is still checked on PUT.",
    ),
  canEdit: z
    .boolean()
    .describe(
      'You may set and remove its value for the tenant, a team or a principal (PUT and DELETE /v1/settings/{key}, every scope it takes): Access.manageSettings, not while impersonating.',
    ),
  canSetMine: z
    .boolean()
    .describe(
      'You may set your own value (PUT and DELETE /v1/settings/{key}/mine): its scopes include `user`.',
    ),
});

/** A stored override, for those who manage settings. */
export const settingOverrideSchema = z.object({
  key: settingKey,
  scope: z.enum(SETTING_SCOPES),
  scopeId: z
    .string()
    .describe(
      "The team's id, the principal's key (`user:<id>`), or '' for the tenant.",
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
        "For team: the team's id; for user: the principal's key (`user:<id>`, `client:<id>`).",
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
