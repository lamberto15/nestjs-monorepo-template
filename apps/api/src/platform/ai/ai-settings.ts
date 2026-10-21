import { defineSettings, setting } from '../settings/setting.types.js';
import { z } from 'zod';

/**
 * A tenant's opt-in: the helper sends a record's fields to an outside
 * provider, so it is off until an administrator turns it on for the tenant.
 */
export const AI_ENABLED = setting({
  key: 'ai.enabled',
  label: 'AI helper',
  description:
    'Let people ask the AI helper to summarize records. Their fields (only those the person may read) are sent to the provider (Anthropic) for each request. Off until you turn it on.',
  schema: z.boolean(),
  default: false,
  public: true, // Everyone signed in may read it, so the web app can hide the helper.
});

/** The helper's own settings, added by the platform to the features'. */
export const AI_SETTINGS = defineSettings([AI_ENABLED]);
