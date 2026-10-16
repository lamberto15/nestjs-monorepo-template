import { z } from 'zod';

/** A record the caller watches. */
export const subscriptionSchema = z.object({
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.string().meta({ example: '0199a3f2-…' }),
  createdAt: z.iso.datetime(),
});

export const watchingSchema = z.object({ watching: z.boolean() });
