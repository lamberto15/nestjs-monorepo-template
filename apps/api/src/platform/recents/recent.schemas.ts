import { z } from 'zod';

/** At most this many recent records per person and tenant: the oldest drops out. */
export const MAX_RECENTS = 20;

/** Recent records older than this many days are deleted (RecentsRetentionJob) and never listed. */
export const RECENTS_RETENTION_DAYS = 30;

/** One recent record of the caller. */
export const recentSchema = z.object({
  id: z.string(),
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.string(),
  label: z.string().meta({ example: 'Q4 plan' }),
  viewedAt: z.iso.datetime(),
});

export const recentListSchema = z.object({ items: z.array(recentSchema) });

export const recordRecentSchema = z.object({
  subject: z
    .string()
    .regex(/^[A-Z]\w*$/, "A record's permission subject: `Note`.")
    .max(100),
  recordId: z.uuid(),
  label: z.string().trim().min(1).max(120),
});
export type RecordRecentDto = z.infer<typeof recordRecentSchema>;
