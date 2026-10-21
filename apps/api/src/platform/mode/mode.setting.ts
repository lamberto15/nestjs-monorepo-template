import { z } from 'zod';
import { defineSettings, setting } from '../settings/setting.types.js';

export const APP_MODES = ['normal', 'read-only', 'maintenance'] as const;
export type AppMode = (typeof APP_MODES)[number];

/**
 * The deployment's mode (docs/settings.md, "Maintenance and read-only
 * mode"): `normal`; `read-only` (writes answer 503 `read_only`, queues
 * pause, cron skips); `maintenance` (everything but health, sign-in and
 * the operators' routes answers 503 `maintenance`). The operators set it
 * for every tenant (`PUT /v1/settings/platform.mode/platform`); no tenant
 * has a scope of its own (`scopes: []`). `APP_MODE` in the environment
 * forces it.
 */
export const PLATFORM_MODE = setting({
  key: 'platform.mode',
  label: 'Deployment mode',
  description:
    'normal, read-only (writes refused, queues paused, cron skipped) or maintenance (only health, sign-in and the operators answer). Operators only.',
  schema: z.enum(APP_MODES),
  default: 'normal' as AppMode,
  scopes: [],
  public: false,
});

export const MODE_SETTINGS = defineSettings([PLATFORM_MODE]);
