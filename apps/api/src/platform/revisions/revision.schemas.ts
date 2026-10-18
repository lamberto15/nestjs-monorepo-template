import { z } from 'zod';

const changesSchema = z
  .record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }))
  .meta({ example: { title: { from: 'Draft', to: 'Plan' } } });

/** A revision of a record, as the API shows it. */
export const revisionSchema = z.object({
  id: z.string(),
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.string(),
  number: z
    .number()
    .int()
    .describe("1 for the record's first state, then one more per change."),
  snapshot: z
    .record(z.string(), z.unknown())
    .describe(
      "The record's changeable fields after the change (custom values in `custom`); fields your permissions don't include are left out.",
    ),
  changes: changesSchema
    .nullable()
    .describe(
      'What changed, from → to (`custom.<key>` per custom value); null for the first revision.',
    ),
  restoredFrom: z
    .number()
    .int()
    .nullable()
    .describe(
      'The revision this change restored; null for an ordinary change.',
    ),
  changedBy: z
    .string()
    .describe(
      'Who made the change: `user:<id>` or `client:<id>`; `anonymized` once their account was deleted; `unknown` for the state a record had before revisions were kept.',
    ),
  changedByName: z
    .string()
    .nullable()
    .describe(
      'The name of who made the change, as every member of the tenant sees it (GET /v1/people); null for `anonymized`, `unknown`, or anyone the tenant never had.',
    )
    .meta({ example: 'Maya Patel' }),
  changedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RevisionView = z.infer<typeof revisionSchema>;

/** The differences between two revisions of a record. */
export const revisionDiffSchema = z.object({
  from: z.number().int().describe('The older side (`a`).'),
  to: z.number().int().describe('The newer side (`b`).'),
  changes: changesSchema.describe(
    'The fields that differ, from `a`’s value to `b`’s (`custom.<key>` per custom value).',
  ),
});
