import { z } from 'zod';

/** `#rrggbb`, stored in lower case. */
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: 'A colour is #rrggbb' })
  .transform((value) => value.toLowerCase())
  .meta({ example: '#3b82f6' });

/** A tag. */
export const tagSchema = z.object({
  id: z.string(),
  subject: z
    .string()
    .describe('What it tags: a permission subject, `Note`.')
    .meta({ example: 'Note' }),
  name: z.string().meta({ example: 'Urgent' }),
  color: z.string().nullable().describe('`#rrggbb`.'),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A tag as a record shows it. */
export const tagRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});
export type TagRef = z.infer<typeof tagRefSchema>;

/** Body of `POST /tags`. */
export const createTagSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(100)
    .describe('A subject whose records take tags: `Note`.')
    .meta({ example: 'Note' }),
  name: z.string().trim().min(1).max(100).meta({ example: 'Urgent' }),
  color: color.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateTagDto = z.infer<typeof createTagSchema>;

/** Body of `PATCH /tags/{id}`: only what is sent changes; null clears. */
export const updateTagSchema = z.object({
  name: createTagSchema.shape.name.optional(),
  color: color.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export type UpdateTagDto = z.infer<typeof updateTagSchema>;

/** Body of `PUT /<records>/{id}/tags`: the record's whole set. */
export const setTagsSchema = z.object({
  tagIds: z
    .array(z.uuid())
    .max(50)
    .describe('Every tag the record carries afterwards; [] removes all.'),
});
export type SetTagsDto = z.infer<typeof setTagsSchema>;
