import { z } from 'zod';

/** A bounded range of Monday-starting UTC weeks for the dashboard chart. */
export const weeklyNoteCountsQuerySchema = z.object({
  from: z.iso.date(),
  weeks: z.coerce.number().int().min(1).max(12).default(8),
});
export const weeklyNoteCountsSchema = z.array(
  z.object({
    week: z.iso.date(),
    count: z.number().int().nonnegative(),
  }),
);
export type WeeklyNoteCountsQuery = z.infer<typeof weeklyNoteCountsQuerySchema>;
