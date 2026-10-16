# Languages and time

## Languages

`@nestjs/i18n`: catalogs in `apps/api/src/i18n/<locale>/<namespace>.json`, keys typed
from the English ones (`apps/api/src/i18n/translations.ts`). Shipped: `en`, `de`,
`ar` (right to left), `zh` (Simplified Chinese), `ms` (Malay). Regions keep
their own date and number formats: `ar-AE` (Dubai), `en-SG`, `zh-SG`,
`ms-SG` (Singapore). The shipped translations are a starting point: have a
native speaker review them.

- The locale: `?lang=`, `X-Lang`, the user's saved language
  (`PATCH /v1/auth/me { locale }`), `Accept-Language`, then the first of
  `LOCALES`. Responses carry `Content-Language`.
- Validation messages come from `validation.json`; throw translated
  messages with `t('auth.invalidLink')`.
- Mail: a template per language (`reset-password.ar.html`; `layout.ar.html`
  sets `dir="rtl"`); subjects from `mail.json`. Mail is sent outside the
  recipient's request: always pass their `locale`.
- A new language: a folder in `apps/api/src/i18n` with every file, templates in
  `apps/api/src/mail/templates`, and its code in `LOCALES`. `apps/api/src/i18n/catalogs.spec.ts`
  fails while a key, a placeholder or a plural form is missing.

## Time

- **Stored and sent in UTC**: `timestamptz` columns, ISO 8601 in the API.
  Clients show local time.
- `APP_TIMEZONE` (default `UTC`): cron jobs, and emails to users who chose
  none. Containers run with `TZ=UTC`.
- A user's time zone (`PATCH /v1/auth/me { timezone: "Asia/Dubai" }`, an IANA
  name) shows the times in their emails and their exports (local time in
  CSV and Excel, ISO 8601 with the offset in JSON;
  [data-transfer.md](data-transfer.md)).
- `APP_TIMEZONE` also covers exports by API clients and users who chose none.
