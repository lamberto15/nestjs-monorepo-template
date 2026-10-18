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
  tenancy: z
    .enum(['multi', 'single'])
    .describe('`single`: the first tenant is the only one.'),
  locales: z
    .array(z.string())
    .describe('The languages the API answers in; the first is the default.'),
  attachments: z
    .object({
      maxBytes: z
        .number()
        .int()
        .describe(
          'The largest file, in bytes (ATTACHMENT_MAX_MB × 1024²): larger is a 413 `payload_too_large`.',
        )
        .meta({ example: 26_214_400 }),
      maxMb: z
        .number()
        .int()
        .describe('The same, in MB (ATTACHMENT_MAX_MB).')
        .meta({ example: 25 }),
      types: z
        .array(z.string())
        .describe(
          'The types a file may be (ATTACHMENT_ALLOWED_TYPES), recognized from its bytes: another is a 415 `unsupported_media_type`.',
        )
        .meta({ example: ['image/png', 'application/pdf', 'text/plain'] }),
    })
    .describe(
      "What a record's attachment may be, as the upload route enforces it.",
    ),
});
export type Features = z.infer<typeof featuresSchema>;
