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
  ai: z
    .boolean()
    .describe(
      'The AI helper has a provider (`ANTHROPIC_API_KEY`). Off: `POST /v1/ai/runs` answers 503 `ai_unavailable`. On, a tenant still opts in with the public setting `ai.enabled` (403 `ai_disabled`).',
    ),
  tenancy: z
    .enum(['multi', 'single'])
    .describe('`single`: the first tenant is the only one.'),
  locales: z
    .array(z.string())
    .describe('The languages the API answers in; the first is the default.'),
});
export type Features = z.infer<typeof featuresSchema>;
