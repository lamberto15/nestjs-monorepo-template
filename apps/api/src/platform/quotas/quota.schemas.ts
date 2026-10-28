import { z } from 'zod';

const amount = z.number().int().min(0);

export const updateQuotasSchema = z
  .object({
    maxMembers: amount.nullable().optional(),
    maxApiClients: amount.nullable().optional(),
    maxStorageBytes: amount.nullable().optional(),
    maxMailsPerDay: amount
      .nullable()
      .optional()
      .describe(
        'Mails queued per UTC day; past mail.essentialOnlyPercent of it, only essential mail goes.',
      ),
    maxRecords: z
      .record(z.string().min(1), amount.nullable())
      .optional()
      .describe('Per feature, by the record’s subject (`Note`).'),
  })
  .strict()
  .describe(
    'The limits of the tenant. A number sets it (0: none allowed), `null` removes the tenant’s own limit (the deployment’s default holds again), an absent key is left as it is.',
  );
export type UpdateQuotas = z.infer<typeof updateQuotasSchema>;

const meter = z.object({
  used: z.number().int(),
  limit: z
    .number()
    .int()
    .nullable()
    .describe('Null: unlimited. The tenant’s own limit, else the default.'),
});

export const tenantUsageSchema = z.object({
  tenantId: z.uuid(),
  members: meter.describe('Active memberships.'),
  apiClients: meter,
  storageBytes: meter.describe('Attachments and issued documents.'),
  mailsPerDay: meter.describe('Mails queued today (UTC).'),
  records: z
    .record(z.string(), meter)
    .describe('Per feature, by the record’s subject.'),
  limits: z
    .object({
      maxMembers: z.number().int().optional(),
      maxApiClients: z.number().int().optional(),
      maxStorageBytes: z.number().int().optional(),
      maxMailsPerDay: z.number().int().optional(),
      maxRecords: z.record(z.string(), z.number().int()).optional(),
    })
    .describe('What the operators set for this tenant (the rest is default).'),
});
export type TenantUsage = z.infer<typeof tenantUsageSchema>;
