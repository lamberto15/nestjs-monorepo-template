import { z } from 'zod';
import { defineSettings, setting } from '../settings/setting.types.js';

/**
 * A tenant's opt-in: the forms routes answer 404 until an administrator
 * turns this on (or the operators do for every tenant, `PUT
 * /v1/settings/forms.enabled/platform`).
 */
export const FORMS_ENABLED = setting({
  key: 'forms.enabled',
  label: 'Forms',
  description:
    'Let administrators build forms and people fill them in. Off until you turn it on.',
  schema: z.boolean(),
  default: false,
  public: true, // Everyone signed in may read it, so the web app can hide forms.
});

/** The forms' own settings, added by the platform to the features'. */
export const FORM_SETTINGS = defineSettings([FORMS_ENABLED]);
