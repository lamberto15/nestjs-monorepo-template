import {
  coreEnv,
  RATE_LIMIT_MULTIPLIER_REFUSED,
  rateLimitMultiplierAllowed,
} from './core/config/core.env.js';
import { secretNames, withSecretFiles } from './core/config/secret-files.js';
import { notesEnv } from './features/notes/notes.env.js';
import { iamEnv } from './iam/iam.env.js';
import { platformEnv } from './platform/platform.env.js';

/**
 * Every variable. Each group declares its own next to its code
 * (`*.env.ts`); a feature adds its schema here.
 */
const variables = coreEnv
  .extend(iamEnv.shape)
  .extend(platformEnv.shape)
  // Features
  .extend(notesEnv.shape)
  // Rules across variables, once every group is in.
  .refine(rateLimitMultiplierAllowed, RATE_LIMIT_MULTIPLIER_REFUSED);

/**
 * The variables that hold secrets (declared with `secret()`): each can come
 * from a file (`X_FILE`), and validation errors never show their values.
 * For whatever must treat them apart later (log redaction: roadmap item 23).
 */
export const SECRET_VARIABLES = secretNames(variables);

/**
 * The whole environment, validated at startup (ConfigModule): the secrets'
 * files read first, then a missing or malformed variable stops the app with
 * its name (never its value).
 */
export const envSchema = withSecretFiles(variables);

export type Env = typeof envSchema._zod.output;
