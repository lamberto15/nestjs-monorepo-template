import { z } from 'zod';
import {
  optional,
  secret,
  withDefault,
} from '../../core/config/env.helpers.js';

/** The example feature's environment. */
export const notesEnv = z.object({
  /** How long a draft waits before its workflow publishes it. */
  NOTE_PUBLISH_DELAY: withDefault('10s'),
  /** Shared with the example sender of incoming webhooks (whsec_…). Unset: created once. */
  EXAMPLE_SENDER_WEBHOOK_SECRET: secret(optional()),
});
