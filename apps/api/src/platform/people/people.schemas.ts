import { z } from 'zod';

/** Rows GET /v1/people answers at most. */
export const MAX_PEOPLE = 20;

/** The query of GET /v1/people. */
export const peopleQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Part of the name, any case (`%` and `_` are themselves). Absent: the first by name.',
      )
      .meta({ example: 'maya' }),
    limit: z.coerce.number().int().min(1).max(MAX_PEOPLE).default(10),
    lang: z.string().max(35).optional(),
  })
  .strict();
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;

/** A member of the tenant, as every member sees them. */
export const personSchema = z.object({
  key: z
    .string()
    .describe(
      'The principal key, `user:<id>`: mention them with `@user:<id>`; the key comments (`author`) and revisions (`changedBy`) hold.',
    )
    .meta({ example: 'user:0198c2a4-6f1e-7c3a-9d2b-5e8f1a2b3c4d' }),
  name: z.string().meta({ example: 'Maya Patel' }),
});
