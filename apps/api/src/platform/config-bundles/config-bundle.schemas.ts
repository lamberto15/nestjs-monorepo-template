import { z } from 'zod';

/** The bundle's format version: a newer one is refused, never half-read. */
export const CONFIG_BUNDLE_VERSION = 1;

const permissionSchema = z.object({
  subject: z.string().min(1),
  action: z.string().min(1),
  conditions: z
    .array(
      z.object({
        key: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(10),
  fields: z.array(z.string().min(1)).max(50).optional(),
});

/**
 * A flag's targeting rule as the bundle carries it: a `role` condition
 * names roles (`{ roleNames: […] }`), never this environment's role ids;
 * the target maps the names to its own roles.
 */
const ruleSchema = z.record(z.string(), z.unknown());

export const bundleSettingSchema = z.object({
  key: z.string().min(1).max(200),
  /** Null: only `rollout` (or the rules) apply (a flag). */
  value: z.unknown(),
  rollout: z.number().int().min(0).max(100).nullable(),
  rules: z.array(ruleSchema).max(50),
});

export const bundleRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  permissions: z.array(permissionSchema).max(100),
});

export const bundleContentsSchema = z.object({
  settings: z.array(bundleSettingSchema).max(1000),
  roles: z.array(bundleRoleSchema).max(200),
});
export type BundleContents = z.infer<typeof bundleContentsSchema>;

/**
 * A configuration bundle (docs/settings.md, "Promoting configuration"):
 * a tenant's settings and custom roles, by stable reference (setting keys,
 * role names), with a SHA-256 checksum of `contents`. No secrets, no
 * credentials, no business records: nothing of the kind is in either.
 */
export const configBundleSchema = z.object({
  format: z.literal('config-bundle'),
  version: z.number().int().min(1),
  exportedAt: z.iso.datetime({ offset: true }),
  /** `sha256:<hex>` of the canonical JSON of `contents` (keys sorted). */
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  contents: bundleContentsSchema,
});
export type ConfigBundle = z.infer<typeof configBundleSchema>;

export const previewBodySchema = z.object({ bundle: configBundleSchema });

export const applyBodySchema = z.object({
  bundle: configBundleSchema,
  /** The preview's `targetVersion`: 409 config_changed when the target changed since. */
  targetVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const changeSchema = z.object({
  type: z.enum(['setting', 'role']),
  /** The setting's key or the role's name. */
  ref: z.string(),
  action: z.enum(['create', 'update', 'unchanged']),
});

const issueSchema = z.object({
  /** The setting's key or the role's name; null for the bundle itself. */
  ref: z.string().nullable(),
  message: z.string(),
});

export const previewSchema = z.object({
  /** No errors: apply may run. */
  valid: z.boolean(),
  errors: z.array(issueSchema),
  /** Applied as they are, but worth a look (an id of this environment's records in a condition). */
  warnings: z.array(issueSchema),
  changes: z.array(changeSchema),
  /** What the target holds now, for what the bundle touches: hand it to apply. */
  targetVersion: z.string(),
});
export type ConfigPreview = z.infer<typeof previewSchema>;

export const appliedSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
