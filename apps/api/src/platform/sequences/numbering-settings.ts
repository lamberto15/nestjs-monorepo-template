import { z } from 'zod';
import { defineSettings, setting } from '../settings/setting.types.js';

/**
 * The month a tenant's fiscal year starts in, for the `FY` naming
 * variable: 1 prints the calendar year (`2026`), 4 a year from April
 * (`2026-2027` from April 2026 to March 2027).
 */
export const NUMBERING_FISCAL_YEAR_START = setting({
  key: 'numbering.fiscalYearStart',
  label: 'Fiscal year start month',
  description:
    'The month (1 to 12) the fiscal year starts in, for FY in naming series: 1 prints 2026, 4 prints 2026-2027 from April 2026.',
  schema: z.number().int().min(1).max(12),
  default: 1,
  public: false,
});

/** The tenant's abbreviation, for the `ABBR` naming variable (ERPNext's company abbreviation). */
export const NUMBERING_ABBREVIATION = setting({
  key: 'numbering.abbreviation',
  label: 'Abbreviation in numbers',
  description:
    "What ABBR prints in naming series (ACME); empty: the tenant's slug in capitals.",
  schema: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9_-]*$/, {
      message: 'Letters, digits, "-" and "_"',
    }),
  default: '',
  public: false,
});

/** Numbering's settings, added by the platform to the features'. */
export const NUMBERING_SETTINGS = defineSettings([
  NUMBERING_FISCAL_YEAR_START,
  NUMBERING_ABBREVIATION,
]);
