import { z } from 'zod';

/** Where a transfer or bulk run is, as GET /v1/data/transfers and GET /v1/bulk tell it. */
export const JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

/** The `?status=` of those lists: one of JOB_STATUSES (a 400 for anything else). */
export const jobStatusFilter = z
  .enum(JOB_STATUSES)
  .optional()
  .describe(
    'Only those in this state: queued (waiting for a worker), running, completed or failed. Default: all.',
  );
