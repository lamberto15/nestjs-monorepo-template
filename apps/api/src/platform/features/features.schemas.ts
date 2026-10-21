import { z } from 'zod';

export const featuresSchema = z.object({
  realtime: z.boolean().describe('The socket.io gateway at `/realtime`.'),
  webhooks: z
    .boolean()
    .describe(
      'The webhook endpoints and deliveries API (`/v1/webhook-endpoints`).',
    ),
  reports: z.boolean().describe('Scheduled reports (`/v1/reports`).'),
  usage: z
    .boolean()
    .describe(
      "API clients' usage and daily quotas (`/v1/access/clients/{id}/usage`).",
    ),
  impersonation: z
    .boolean()
    .describe('Support impersonation (`/v1/access/users/{id}/impersonate`).'),
  mfa: z
    .boolean()
    .describe(
      'Two-factor enrollment (`/v1/auth/mfa/enroll`). Off: enrolled users are still asked for a code.',
    ),
  apiClients: z
    .boolean()
    .describe('API clients (`/v1/access/clients`) and their keys.'),
  passkeys: z.boolean().describe('Passkeys (`/v1/auth/passkeys`).'),
  signUp: z.boolean().describe('Self sign-up (`POST /v1/auth/sign-up`).'),
  magicLink: z
    .boolean()
    .describe('Sign-in by email link (`POST /v1/auth/magic-link`).'),
  documents: z
    .boolean()
    .describe(
      'PDF documents of records. Off: they answer 503 `documents_unavailable` (no Gotenberg is configured).',
    ),
  presignedUploads: z
    .boolean()
    .describe(
      'Uploads straight to the object store (`STORAGE_DRIVER=s3`): `POST /v1/<records>/{id}/attachments/presign`, then `…/complete`. Off: they answer 503 `presigned_uploads_unavailable`; upload with the multipart `POST …/attachments`.',
    ),
  ai: z
    .boolean()
    .describe(
      'The AI helper has a provider (`ANTHROPIC_API_KEY`). Off: `POST /v1/ai/runs` answers 503 `ai_unavailable`. On, a tenant still opts in with the public setting `ai.enabled` (403 `ai_disabled`).',
    ),
  exchangeRates: z
    .boolean()
    .describe(
      'The ECB reference rates are fetched (`EXCHANGE_RATES_FETCH`). Off: no rates are stored, and the money conversions have none.',
    ),
  tenancy: z
    .enum(['multi', 'single'])
    .describe('`single`: the first tenant is the only one.'),
  mode: z
    .enum(['normal', 'read-only', 'maintenance'])
    .describe(
      "`platform.mode` / `APP_MODE`. `read-only`: writes answer 503 `read_only`. `maintenance`: everything but health, sign-in and the operators' routes answers 503 `maintenance`. Both carry `Retry-After`.",
    ),
  locales: z
    .array(z.string())
    .describe('The languages the API answers in; the first is the default.'),
});
export type Features = z.infer<typeof featuresSchema>;
