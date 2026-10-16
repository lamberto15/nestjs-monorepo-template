import { z } from 'zod';

export const usageQuerySchema = z.object({
  from: z.iso
    .date()
    .optional()
    .describe(
      'The first UTC day (yyyy-mm-dd), included; default: 29 days before `to`.',
    ),
  to: z.iso
    .date()
    .optional()
    .describe('The last UTC day, included; default: today.'),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const usageReportSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  days: z
    .array(
      z.object({
        day: z.iso.date(),
        total: z.number().int(),
        routes: z
          .record(z.string(), z.number().int())
          .describe(
            'Requests per route: `<METHOD> <pattern>`, as `GET /v1/notes/{id}`.',
          ),
      }),
    )
    .describe(
      'Every day of the range, oldest first, today with its live count.',
    ),
  total: z.number().int(),
});
