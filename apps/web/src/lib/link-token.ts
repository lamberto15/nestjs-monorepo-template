import { z } from '@/lib/zod';

/** The `?token=` of an email link's page (reset, verify, invitation…). */
export const tokenSearchSchema = z.object({
  token: z.string().min(1).max(2048).optional().catch(undefined),
});

/** The browser's time zone (IANA), for a new account. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
