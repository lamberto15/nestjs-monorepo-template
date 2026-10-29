import { z } from 'zod';
import {
  BRANDING_DARK_PRIMARY_COLOR,
  BRANDING_MAIL_FROM_NAME,
  BRANDING_PRIMARY_COLOR,
} from './branding.settings.js';

export const brandingSchema = z.object({
  primaryColor: z
    .string()
    .nullable()
    .describe('`#rrggbb`, or null: the default theme.'),
  darkPrimaryColor: z
    .string()
    .nullable()
    .describe(
      '`#rrggbb` for the dark theme of the web app, or null: `primaryColor` holds.',
    ),
  mailFromName: z
    .string()
    .nullable()
    .describe('The name mail is sent under, or null: the deployment’s.'),
  logoUrl: z
    .string()
    .nullable()
    .describe(
      'The path of the logo (`/v1/branding/{tenantId}/logo`, public), or null.',
    ),
  darkLogoUrl: z
    .string()
    .nullable()
    .describe(
      'The path of the dark-mode logo (`/v1/branding/{tenantId}/logo/dark`, public), or null: the logo holds.',
    ),
  locked: z
    .boolean()
    .describe('The operators locked it: `PUT` and the logo routes answer 409.'),
  canEdit: z
    .boolean()
    .describe('The caller may change it (and it is not locked).'),
});
export type Branding = z.infer<typeof brandingSchema>;

/** The same schemas the settings use: one rule for the colour and the name, whichever route sets them. */
export const updateBrandingSchema = z
  .object({
    primaryColor: BRANDING_PRIMARY_COLOR.schema.optional(),
    darkPrimaryColor: BRANDING_DARK_PRIMARY_COLOR.schema.optional(),
    mailFromName: BRANDING_MAIL_FROM_NAME.schema.optional(),
  })
  .strict()
  .describe(
    'A value sets it, `null` removes it (the default holds again), an absent key stays.',
  );
export type UpdateBranding = z.infer<typeof updateBrandingSchema>;
