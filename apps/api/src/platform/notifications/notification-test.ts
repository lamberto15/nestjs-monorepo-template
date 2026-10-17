import { z } from 'zod';
import { nodeEnvRefusal } from '../../demo/demo-guard.js';
import { defineNotifications } from './notification.types.js';

/**
 * Whether this process is a development (or test) one: the same NODE_ENV
 * check as the demo seed (`nodeEnvRefusal`, src/demo/demo-guard.ts), read
 * from `process.env` when the module graph is built, as the deployment
 * switches are (platform/switches.ts). Anything not shown to be development
 * (production, staging, an unset NODE_ENV) is not.
 */
export const isDevelopment = () =>
  nodeEnvRefusal(process.env.NODE_ENV) === null;

/** `items` in development and tests, else nothing: spreads into controller and declaration lists. */
export const inDevelopment = <T>(...items: T[]): T[] =>
  isDevelopment() ? items : [];

/**
 * The type `POST /v1/notifications/test` sends (texts:
 * `i18n/<locale>/notifications.json`, under `system.test`). Declared only in
 * development, like the route: production's catalog and preferences don't
 * list it. Mail goes at once and the webhook is on by default, so one call
 * exercises every channel the caller has on.
 */
export const TEST_NOTIFICATIONS = defineNotifications([
  {
    type: 'system.test',
    channels: { email: 'immediate', webhook: true },
    data: z.object({ at: z.iso.datetime() }),
  },
]);
