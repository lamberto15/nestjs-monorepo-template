import { z } from 'zod';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../core/http/pagination.js';
import { TRANSFER_FORMATS } from '../data-transfer/data-transfer.types.js';
import { CONSENT_KIND_PATTERN } from './consent-kinds.js';

export const deletionSchema = z.object({
  requestedAt: z.iso.datetime(),
  scheduledFor: z.iso
    .datetime()
    .describe('When the account is deleted, unless cancelled before.'),
});

export const consentSchema = z.object({
  kind: z.string().meta({ example: 'terms' }),
  version: z
    .string()
    .meta({ example: '2026-01' })
    .describe('The version accepted last.'),
  acceptedAt: z.iso.datetime().describe('When it was accepted last.'),
  withdrawnAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When it was withdrawn (DELETE /v1/account/consents/{kind}); null: in force.',
    ),
});

export const consentKindSchema = z.object({
  kind: z.string().meta({ example: 'marketing' }),
  version: z
    .string()
    .meta({ example: '2026-01' })
    .describe(
      'The version in force: the only one POST /v1/account/consents accepts. A consent of an older version is to be asked for again.',
    ),
  required: z
    .boolean()
    .describe(
      'Needed to use the service (the terms, the privacy policy): it cannot be withdrawn, only the account deleted. false: optional, withdrawn at will.',
    ),
  label: z
    .string()
    .meta({ example: 'Marketing emails' })
    .describe("In the request's language."),
  description: z.string().describe("In the request's language."),
});

export const accountStateSchema = z.object({
  deletion: deletionSchema
    .nullable()
    .describe('A pending deletion of this account, or null.'),
  consents: z
    .array(consentSchema)
    .describe(
      'Each kind you accepted: the latest version, and whether it was withdrawn.',
    ),
});

export const requestDeletionSchema = z
  .object({
    password: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Your current password: required when the account has one.'),
  })
  .strict();

export const cancelDeletionByLinkSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(2048)
      .describe("The `token` of the deletion mail's cancel link."),
  })
  .strict();

export const acceptConsentSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .regex(CONSENT_KIND_PATTERN, 'a name: terms, privacy, marketing')
      .meta({ example: 'terms' })
      .describe('A kind GET /v1/account/consent-kinds lists.'),
    version: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .meta({ example: '2026-01' })
      .describe("That kind's current `version`."),
  })
  .strict();

export const exportRequestSchema = z
  .object({
    format: z.enum(TRANSFER_FORMATS).default('json'),
  })
  .strict();

export const accountExportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.uuid().optional().describe('`nextCursor` of the previous page.'),
});
