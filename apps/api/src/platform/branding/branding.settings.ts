import { z } from 'zod';
import { defineSettings, flag, setting } from '../settings/setting.types.js';

/** `#rrggbb` and nothing else: the value ends up in CSS and in mail styles, so no names, functions or `url()`. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * A display name for the mail sender and the signature. Letters, digits,
 * spaces and ordinary punctuation: no control or format characters
 * (header injection, bidi tricks), none of `< > " \ @ ; , :` that would
 * make an address of it.
 */
export const DISPLAY_NAME = /^[^\p{C}<>"\\@;,:]+$/u;

/**
 * The tenant's branding (docs/branding.md): the accent colour of the web
 * app, mail and documents, and the name mail is sent under. The logo is
 * a file, kept on the private disk by BrandingService. Tenant scope only:
 * a unit or a person has no brand of their own.
 */
export const BRANDING_PRIMARY_COLOR = setting({
  key: 'branding.primaryColor',
  label: 'Brand colour',
  description: 'A colour as #rrggbb: the web app’s accent, mail and documents.',
  schema: z.string().regex(HEX_COLOR, 'Use a colour as #rrggbb.').nullable(),
  default: null as string | null,
});

export const BRANDING_MAIL_FROM_NAME = setting({
  key: 'branding.mailFromName',
  label: 'Mail sender name',
  description: 'The name mail is sent under and signed with.',
  schema: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(DISPLAY_NAME, 'Letters, numbers and plain punctuation only.')
    .nullable(),
  default: null as string | null,
});

/**
 * The operators' lock: while it is on, the tenant's administrators can't
 * change the three values above or the logo (409 `branding_locked`); what
 * is stored stays in force. No scope of its own: operators set it for
 * every tenant (`PUT /v1/settings/branding.locked/platform`), or for some
 * (a platform rule on `tenantSlug`). To set the values instead of
 * freezing them, they enforce the values at the platform scope.
 */
export const BRANDING_LOCKED = flag({
  key: 'branding.locked',
  label: 'Branding locked',
  description: 'Tenant administrators can’t change the branding.',
  default: false,
  scopes: [],
  public: false,
});

export const BRANDING_SETTINGS = defineSettings([
  BRANDING_PRIMARY_COLOR,
  BRANDING_MAIL_FROM_NAME,
  BRANDING_LOCKED,
]);
