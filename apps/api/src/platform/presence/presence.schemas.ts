import { z } from 'zod';

/** How long a heartbeat keeps someone present; pages beat every PRESENCE_BEAT_SECONDS. */
export const PRESENCE_TTL_SECONDS = 45;
export const PRESENCE_BEAT_SECONDS = 15;

/** At most this many people are shown on a record. */
export const MAX_PRESENT = 25;

export const presenceModeSchema = z.enum(['viewing', 'editing']);
export type PresenceMode = z.infer<typeof presenceModeSchema>;

export const presenceBodySchema = z.object({ mode: presenceModeSchema });
export type PresenceBodyDto = z.infer<typeof presenceBodySchema>;

/** A record by its permission subject and id (the path). */
export interface PresenceParams {
  subject: string;
  recordId: string;
}

/** The people on a record now. */
export const presenceListSchema = z.object({
  items: z.array(
    z.object({
      key: z.string().describe('The principal key: `user:<id>`.'),
      name: z.string(),
      mode: presenceModeSchema,
      self: z.boolean().describe('It is you (another tab of yours).'),
    }),
  ),
});
