import { z } from 'zod';
import { DEVICE_PLATFORMS } from './messaging.tables.js';

export const registerDeviceSchema = z
  .object({
    platform: z.enum(DEVICE_PLATFORMS),
    name: z.string().trim().min(1).max(100).meta({ example: 'Pixel 9' }),
    token: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        "The push provider's token. Web: the browser's `PushSubscription` as JSON.",
      ),
  })
  .strict();

export const deviceSchema = z.object({
  id: z.uuid(),
  platform: z.enum(DEVICE_PLATFORMS),
  name: z.string(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type DeviceView = z.infer<typeof deviceSchema>;

export const setPhoneSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .min(7)
      .max(25)
      .meta({ example: '+4915112345678' })
      .describe('With its country code (E.164).'),
  })
  .strict();

export const verifyPhoneSchema = z
  .object({ code: z.string().regex(/^\d{6}$/, 'six digits') })
  .strict();

export const phoneSchema = z.object({
  phone: z
    .string()
    .nullable()
    .describe('Masked (`+49•••••78`); null when none is set.'),
  verified: z.boolean(),
  optedOut: z
    .boolean()
    .describe(
      'The number replied STOP: no SMS is sent until it replies START.',
    ),
});
export type PhoneView = z.infer<typeof phoneSchema>;
