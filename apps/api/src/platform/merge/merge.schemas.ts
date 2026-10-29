import { z } from 'zod';

/** At most this many duplicates are listed: the likeliest are the newest. */
export const MAX_DUPLICATES = 20;

const shownRecordSchema = z
  .record(z.string(), z.unknown())
  .describe('The record as you may read it (fields hidden from you left out).');

/** A likely duplicate: the record, and the rules it matched. */
export const duplicateSchema = z
  .object({
    id: z.uuid(),
    matched: z
      .array(z.array(z.string()))
      .describe(
        'The rules it matched, each the fields whose values are the same (text without case or surrounding spaces).',
      )
      .meta({ example: [['title']] }),
    record: shownRecordSchema,
  })
  .meta({ id: 'Duplicate' });

export const duplicateListSchema = z
  .object({ items: z.array(duplicateSchema) })
  .meta({ id: 'DuplicateList' });

/** POST /<path>/duplicates: values a record would have, before it is created or changed. */
export const findDuplicatesSchema = z.object({
  values: z
    .record(
      z.string(),
      z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]),
    )
    .describe("The record's values by field (a create or PATCH body's)."),
  excludeId: z
    .uuid()
    .optional()
    .describe('The record being changed: never its own duplicate.'),
});
export type FindDuplicatesDto = z.infer<typeof findDuplicatesSchema>;

/** POST …/{id}/merge and …/merge/preview: the duplicate, and which values survive. */
export const mergeSchema = z.object({
  duplicateId: z
    .uuid()
    .describe(
      'The record merged into this one: it goes to the recycle bin once merged.',
    ),
  fields: z
    .record(z.string(), z.enum(['survivor', 'duplicate']))
    .default({})
    .describe(
      "Whose value each field keeps: `duplicate` takes the duplicate's; any field left out keeps the survivor's.",
    )
    .meta({ example: { title: 'duplicate' } }),
});
export type MergeDto = z.infer<typeof mergeSchema>;

/** What a merge would do, as the caller may see it. */
export const mergePreviewSchema = z
  .object({
    survivor: shownRecordSchema,
    duplicate: shownRecordSchema,
    fields: z
      .array(
        z.object({
          name: z.string(),
          survivor: z.unknown(),
          duplicate: z.unknown(),
          differs: z.boolean(),
          keep: z.enum(['survivor', 'duplicate']),
        }),
      )
      .describe(
        'The fields you may read on both records and change on the survivor: the ones you may choose.',
      ),
    result: shownRecordSchema.describe('The survivor once merged.'),
    moves: z
      .object({
        tags: z.int(),
        comments: z.int(),
        attachments: z.int(),
        watchers: z.int(),
        references: z.array(
          z.object({
            subject: z.string(),
            field: z.string(),
            count: z.int(),
          }),
        ),
      })
      .describe(
        "What moves from the duplicate to the survivor: its tags, comments, attachments and watchers, and the records whose references point at it. The duplicate's revisions stay with it.",
      ),
  })
  .meta({ id: 'MergePreview' });
export type MergePreview = z.infer<typeof mergePreviewSchema>;
