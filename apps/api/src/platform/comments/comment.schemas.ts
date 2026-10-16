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
  body: z.string(),
  mentions: z
    .array(z.string())
    .describe(
      'The people mentioned (`@<email>` or `@user:<id>` in the body) who may read the record, as `user:<id>`.',
    ),
  editedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CommentView = z.infer<typeof commentSchema>;
