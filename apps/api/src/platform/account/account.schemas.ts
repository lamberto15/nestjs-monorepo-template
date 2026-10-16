import { z } from 'zod';
import { TRANSFER_FORMATS } from '../data-transfer/data-transfer.types.js';

export const deletionSchema = z.object({
  requestedAt: z.iso.datetime(),
  scheduledFor: z.iso
    .datetime()
    .describe('When the account is deleted, unless cancelled before.'),
});

export const consentSchema = z.object({
  kind: z.string().meta({ example: 'terms' }),
  version: z.string().meta({ example: '2026-01' }),
  acceptedAt: z.iso.datetime(),
});

export const accountStateSchema = z.object({
  deletion: deletionSchema
    .nullable()
    .describe('A pending deletion of this account, or null.'),
  consents: z
    .array(consentSchema)
    .describe('The latest version accepted of each kind.'),
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

export const acceptConsentSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .regex(/^[a-z][a-zA-Z0-9-]*$/, 'a name: terms, privacy, marketing')
      .max(50)
      .meta({ example: 'terms' }),
    version: z.string().trim().min(1).max(50).meta({ example: '2026-01' }),
  })
  .strict();

export const exportRequestSchema = z
  .object({
    format: z.enum(TRANSFER_FORMATS).default('json'),
  })
  .strict();
