import { z } from 'zod';
import { pageQuerySchema, pageSchema } from '../../core/http/pagination.js';
import { QUALITY_CHECKS, QUALITY_SEVERITIES } from './data-quality.tables.js';

/** A scan of the tenant's records: its progress, and how it ended. */
export const dataQualityScanSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['queued', 'running', 'completed', 'failed']),
    total: z.int().describe('The records to check when it started.'),
    scanned: z.int().describe('The records checked so far.'),
    findings: z
      .int()
      .nullable()
      .describe('Open findings once it completed; null before.'),
    startedBy: z.string().meta({ example: 'user:0198…' }),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'DataQualityScan' });
export type DataQualityScanView = z.infer<typeof dataQualityScanSchema>;

/** What GET /v1/data-quality answers: the open findings per subject, and the last scan. */
export const dataQualitySummarySchema = z
  .object({
    lastScan: dataQualityScanSchema
      .nullable()
      .describe(
        'The newest scan (running or not): how fresh the findings are.',
      ),
    subjects: z.array(
      z.object({
        subject: z.string().meta({ example: 'Note' }),
        errors: z.int(),
        suggestions: z.int(),
        dismissed: z.int(),
      }),
    ),
  })
  .meta({ id: 'DataQualitySummary' });

export const dataQualityFindingSchema = z
  .object({
    id: z.uuid(),
    subject: z.string().meta({ example: 'Note' }),
    recordId: z.uuid(),
    check: z
      .enum(QUALITY_CHECKS)
      .describe(
        '`missing`: a recommended field is empty; `reference`: it refers to a record in the recycle bin; `duplicate`: another record has the same value.',
      ),
    field: z.string().meta({ example: 'body' }),
    severity: z.enum(QUALITY_SEVERITIES),
    detail: z
      .record(z.string(), z.string())
      .nullable()
      .describe(
        '`referencedId` (reference), `duplicateOf`: the other record (duplicate).',
      ),
    checkedAt: z.iso.datetime(),
    dismissedAt: z.iso.datetime().nullable(),
    dismissedBy: z.string().nullable(),
  })
  .meta({ id: 'DataQualityFinding' });
export type DataQualityFindingView = z.infer<typeof dataQualityFindingSchema>;

export const dataQualityFindingPageSchema = pageSchema(
  dataQualityFindingSchema,
).meta({ id: 'DataQualityFindingPage' });

/** Query of GET /v1/data-quality/subjects/{subject}/findings. */
export const findingsQuerySchema = pageQuerySchema
  .pick({ limit: true, cursor: true })
  .extend({
    severity: z.enum(QUALITY_SEVERITIES).optional(),
    check: z.enum(QUALITY_CHECKS).optional(),
    dismissed: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true')
      .describe('true: the dismissed ones instead of the open ones.'),
    lang: z.string().max(35).optional(),
  });
export type FindingsQuery = z.infer<typeof findingsQuerySchema>;

/** What a recheck answers: the finding if it still holds. */
export const recheckResultSchema = z
  .object({
    resolved: z.boolean().describe('true: the problem is gone.'),
    finding: dataQualityFindingSchema.nullable(),
  })
  .meta({ id: 'DataQualityRecheck' });
