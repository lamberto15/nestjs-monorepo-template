import {
  coreEnv,
  RATE_LIMIT_MULTIPLIER_REFUSED,
  rateLimitMultiplierAllowed,
} from './core/config/core.env.js';
import { secretNames, withSecretFiles } from './core/config/secret-files.js';
import { logRedaction } from './core/logging/redaction.js';
import { featuresEnv } from './features/env.js';
import { passkeyEnvIssues } from './iam/account/passkeys.config.js';
import { iamEnv } from './iam/iam.env.js';
import { platformEnv } from './platform/platform.env.js';

/**
 * Every variable. Each group declares its own next to its code
 * (`*.env.ts`); features through features/env.ts.
 */
const variables = coreEnv
  .extend(iamEnv.shape)
  .extend(platformEnv.shape)
  // Features
  .extend(featuresEnv.shape)
  // Rules across variables, once every group is in.
  .refine(rateLimitMultiplierAllowed, RATE_LIMIT_MULTIPLIER_REFUSED)
  // The passkey relying party must be consistent before a credential is
  // bound to it (docs/auth.md, "Passkeys"): each problem names its variable.
  .superRefine((env, ctx) => {
    for (const [variable, message] of passkeyEnvIssues(env)) {
      ctx.addIssue({ code: 'custom', path: [variable], message });
    }
  });

/**
 * The variables that hold secrets (declared with `secret()`): each can come
 * from a file (`X_FILE`), validation errors never show their values, and
 * the logs mask them by name (core/logging/redaction.ts).
 */
export const SECRET_VARIABLES = secretNames(variables);
logRedaction.declareFields(...SECRET_VARIABLES);

/**
 * The whole environment, validated at startup (ConfigModule): the secrets'
 * files read first, then a missing or malformed variable stops the app with
 * its name (never its value).
 */
export const envSchema = withSecretFiles(variables);

type Env = typeof envSchema._zod.output;
