/**
 * The API's limits of the account forms: `maxLength` and `minLength` in the
 * sign-up, profile, password, invitation and passkey schemas. Constants
 * rather than a read of `@nestjs-monorepo-template/api-client/openapi.json`
 * (it would put the whole document into the bundle); lib/limits.test.ts
 * compares them with it, so a change of the API fails the test.
 */
export const AUTH_LIMITS = {
  name: 120,
  tenantName: 120,
  passkeyName: 64,
  passwordMin: 12,
  passwordMax: 128,
} as const;
