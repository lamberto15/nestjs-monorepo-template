import { z } from 'zod';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../../core/http/pagination.js';

/** Rows GET /v1/people answers at most, and the keys `key=` resolves at most. */
export const MAX_PEOPLE = 20;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A principal key a member may resolve to a name: `user:<uuid>` or `client:<uuid>`. */
const PERSON_KEY = new RegExp(`^(user|client):${UUID}$`);

/** `a,b,c`: the items, trimmed, without empty ones. */
const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

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
        'Part of the name, any case (`%` and `_` are themselves). Absent: the first by name. Not with `key`.',
      )
      .meta({ example: 'maya' }),
    key: commaList
      .pipe(
        z
          .array(
            z
              .string()
              .regex(PERSON_KEY, 'A key is `user:<uuid>` or `client:<uuid>`'),
          )
          .min(1)
          .max(MAX_PEOPLE),
      )
      .optional()
      .describe(
        `Principal keys to name instead of a search, comma-separated, ${MAX_PEOPLE} at most: \`user:<id>\` (a member, or a former member: they still own records) or \`client:<id>\` (an API client of your tenant). A key with no name in your tenant is left out of the answer. Not with \`q\`; \`limit\` doesn't apply.`,
      )
      .meta({ example: 'user:0198c2a4-6f1e-7c3a-9d2b-5e8f1a2b3c4d' }),
    limit: z.coerce.number().int().min(1).max(MAX_PEOPLE).default(10),
    lang: z.string().max(35).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.q !== undefined && query.key !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message: '`q` searches, `key` names: send one of them',
        input: query.key,
      });
    }
  });
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;

/** A member of the tenant, as every member sees them. */
export const personSchema = z.object({
  key: z
    .string()
    .describe(
      'The principal key, `user:<id>` (`client:<id>` only when asked for by `key`): mention a user with `@user:<id>`; the key comments (`author`), revisions (`changedBy`) and records (`ownerId`) hold.',
    )
    .meta({ example: 'user:0198c2a4-6f1e-7c3a-9d2b-5e8f1a2b3c4d' }),
  name: z.string().meta({ example: 'Maya Patel' }),
  avatarUrl: z
    .string()
    .nullable()
    .describe(
      'Their picture: a path on this API for an `<img>` (GET /v1/people/{id}/avatar; sign-in required); null: none, and always for an API client. A new picture is a new address.',
    ),
});

/** The query of GET /v1/people/{id}/avatar. */
export const avatarQuerySchema = z
  .object({
    v: z
      .string()
      .max(100)
      .optional()
      .describe(
        'The version in `avatarUrl`: it only tells a new picture from the one a browser kept, and is not read.',
      ),
  })
  .strict();
export type AvatarQuery = z.infer<typeof avatarQuerySchema>;

/** The query of GET /v1/teams. */
export const teamsQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Part of the team name, any case (`%` and `_` are themselves).')
      .meta({ example: 'sales' }),
    id: commaList
      .pipe(z.array(z.uuid()).min(1).max(MAX_LIMIT))
      .optional()
      .describe(
        `Team ids to name, comma-separated, ${MAX_LIMIT} at most: an id your tenant has no team of is left out of the answer.`,
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Teams a page holds: ${DEFAULT_LIMIT} without it, ${MAX_LIMIT} at most (more is a 400). It applies with \`id\` too: send at least as many as the ids.`,
      ),
    cursor: z
      .uuid()
      .optional()
      .describe('`nextCursor` of the previous page (the same `q` and `id`).'),
    lang: z.string().max(35).optional(),
  })
  .strict();
export type TeamsQuery = z.infer<typeof teamsQuerySchema>;

/** A team of the tenant, as every member sees it: its name and its place in the tree. */
export const teamRefSchema = z.object({
  id: z.uuid().describe("What a record's `teamId` holds."),
  name: z.string().meta({ example: 'North' }),
  parentId: z
    .uuid()
    .nullable()
    .describe('The team it is under; null for a top-level team.'),
  depth: z.number().int().describe('0 for a top-level team.'),
});
