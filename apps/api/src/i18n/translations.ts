import type approvals from './en/approvals.json';
import type auth from './en/auth.json';
import type mail from './en/mail.json';
import type money from './en/money.json';
import type notifications from './en/notifications.json';
import type transfer from './en/transfer.json';
import type validation from './en/validation.json';

/**
 * The shape of the catalogs, from the English ones: a key that doesn't exist
 * there fails to compile. Add a namespace here when you add a JSON file to
 * `en/` (and to every other locale).
 */
export interface Translations {
  approvals: typeof approvals;
  auth: typeof auth;
  mail: typeof mail;
  money: typeof money;
  notifications: typeof notifications;
  transfer: typeof transfer;
  validation: typeof validation;
}

declare module '@nestjs/i18n' {
  interface I18nTypes {
    translations: Translations;
  }
}
