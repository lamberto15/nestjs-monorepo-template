import { z } from 'zod';
import { FAVORITE_KINDS } from './favorites.tables.js';

/** At most this many favorites per person and tenant. */
export const MAX_FAVORITES = 50;

/** One of the caller's favorites. */
export const favoriteSchema = z.object({
  id: z.string(),
  kind: z.enum(FAVORITE_KINDS),
  subject: z
    .string()
    .describe("A record's permission subject (`Note`); empty otherwise.")
    .meta({ example: 'Note' }),
  target: z
    .string()
    .describe("The record's id, the page's path (`/notes`) or the view's id."),
  label: z.string().meta({ example: 'Q4 plan' }),
  createdAt: z.iso.datetime(),
});

export const favoriteListSchema = z.object({
  items: z.array(favoriteSchema),
});

export const createFavoriteSchema = z
  .object({
    kind: z.enum(FAVORITE_KINDS),
    subject: z.string().max(100).default(''),
    target: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(200),
  })
  .refine((value) => (value.kind === 'record') === (value.subject !== ''), {
    message: 'A record needs its subject; a page or a view has none.',
    path: ['subject'],
  })
  .refine((value) => value.kind !== 'page' || value.target.startsWith('/'), {
    message: "A page is the app's path: `/notes`.",
    path: ['target'],
  })
  .refine(
    (value) =>
      value.kind === 'page' || z.uuid().safeParse(value.target).success,
    { message: "A record's or a view's id.", path: ['target'] },
  );
export type CreateFavoriteDto = z.infer<typeof createFavoriteSchema>;

export const reorderFavoritesSchema = z.object({
  ids: z
    .array(z.string())
    .max(MAX_FAVORITES)
    .describe('Every one of your favorites, in the new order.'),
});
export type ReorderFavoritesDto = z.infer<typeof reorderFavoritesSchema>;
