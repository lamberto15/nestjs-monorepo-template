import { z } from 'zod';

/** The longest comment, in characters. */
export const MAX_COMMENT_LENGTH = 10_000;

/** Body of `POST …/comments` and `PATCH …/comments/{commentId}`. */
export const commentBodySchema = z.object({
  body: z.string().trim().min(1).max(MAX_COMMENT_LENGTH).meta({
    example: 'Looks good to me, @ada@example.com: can you check the numbers?',
  }),
});
export type CommentBodyDto = z.infer<typeof commentBodySchema>;

/** A comment, as the API shows it. */
export const commentSchema = z.object({
  id: z.string(),
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.string(),
  author: z
    .string()
    .describe(
      'Who wrote it: `user:<id>` or `client:<id>`; `anonymous` once their account was deleted.',
    ),
  authorName: z
    .string()
    .nullable()
    .describe(
      "The author's name, as every member of the tenant sees it (GET /v1/people); null once their account was deleted (`anonymous`), or for anyone the tenant never had.",
    )
    .meta({ example: 'Maya Patel' }),
  body: z.string(),
  mentions: z
    .array(z.string())
    .describe(
      'The people mentioned (`@<email>` or `@user:<id>` in the body) who may read the record, as `user:<id>`.',
    ),
  mentionNames: z
    .record(z.string(), z.string().nullable())
    .describe(
      'The name of each key in `mentions`, as every member of the tenant sees it (GET /v1/people): `{ "user:<id>": "Maya Patel" }`. A person who left the tenant keeps their name, as `authorName` does; null for anyone the tenant never had.',
    )
    .meta({
      example: { 'user:0f8e3c52-6d1a-4b7e-9c2f-5a4b3d2e1f00': 'Maya Patel' },
    }),
  editedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CommentView = z.infer<typeof commentSchema>;
