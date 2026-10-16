import { z } from 'zod';
import { defineSettings, setting } from '../settings/setting.types.js';

/** How long a delegation (out of office) may last: a stand-in for a holiday, not for good. */
export const APPROVAL_MAX_DELEGATION_DAYS = setting({
  key: 'approvals.maxDelegationDays',
  label: 'Longest delegation (days)',
  description:
    'How long a delegation of approvals may last, from its start to its end, in days.',
  schema: z.number().int().min(1).max(3650),
  default: 90,
  public: false,
});

/** The approvals' own settings, added by the platform to the features'. */
export const APPROVAL_SETTINGS = defineSettings([APPROVAL_MAX_DELEGATION_DAYS]);
