# Tenant branding

A tenant's colour, logo and sender name, shown by the web app, the mail the
tenant sends and its PDF documents. The code is in
`apps/api/src/platform/branding/` (and `core/mail/mail-branding.ts`); the page
is `/branding` in the web app (`apps/web/src/features/branding`).

| What | Where it lives | Shown in |
| --- | --- | --- |
| `branding.primaryColor`: `#rrggbb` | a tenant setting ([settings](settings.md)) | the web theme, mail (the card's top edge), documents (the page's top rule and name) |
| `branding.mailFromName` | a tenant setting | the sender's display name of every mail, and its signature; documents show it under the logo |
| the logo: PNG, JPEG or WebP, 512 KB | the private disk, `tenants/<id>/branding/logo` ([attachments](attachments.md) for the disk) | the menu's tenant switcher, mail, documents |
| `branding.locked` | a flag the operators set | refuses changes, below |

The colour and the name are ordinary settings, so they are audited as
`setting.updated` / `setting.reset`, cached per tenant and readable at
`GET /v1/settings`; the branding routes below are a shortcut over them, with
the same schemas. The logo is a file, not a setting: its key is built from the
request's tenant (never from the client), so no value can point at another
tenant's file.

## Routes

```
GET    /v1/branding                    { primaryColor, mailFromName, logoUrl, locked, canEdit }   any signed-in caller
PUT    /v1/branding                    { primaryColor?, mailFromName? }   null removes, absent stays   Access.manageSettings
POST   /v1/branding/logo               multipart, field `file`   201, the branding   Access.manageSettings
DELETE /v1/branding/logo               204   Access.manageSettings
GET    /v1/branding/{tenantId}/logo    302 to a signed link (5 minutes)   no sign-in
```

`logoUrl` is the path of the last route. It is public on purpose: a mail client
and the sign-in page show it without a session, and the logo is in every mail
the tenant sends. It reveals nothing but the image, to someone who has the
tenant's id.

## What is checked

- **The colour** is `#rrggbb` and nothing else (`/^#[0-9a-fA-F]{6}$/`): no names,
  `rgb()`, `var()`, `url()`, no third digit pair, no trailing newline. It is
  written into CSS (the web's inline custom properties, a mail's and a PDF's
  `style` attribute), so the one shape is checked where it is stored, again by
  the web before it reaches a style (`applyBrandColor`), and escaped by the
  templates. The web computes the text colour on it (black or white, by
  luminance).
- **The sender name** is 1 to 60 characters, trimmed, with no control or
  format characters (a line break, a bidi override) and none of `< > " \ @ ; , :`
  (header injection, a fake address). Only the display name changes: the
  address stays `MAIL_FROM`'s, which the mail provider has verified (SPF, DKIM,
  [deliverability](deliverability.md)). A mail class that sets its own `from`
  keeps it.
- **The logo** is recognized by its first bytes (`uploadToDisk()`'s signature
  detection): PNG, JPEG or WebP, whatever the name or the declared type says
  (415 `unsupported_media_type` for anything else). **SVG is refused** on
  purpose: it can carry scripts. At most 512 KB (413). A refused or cut upload
  never replaces the logo that is there. The file is served under the files'
  `Content-Security-Policy` and `nosniff`.

## In mail

`MailQueue.send()` asks the core's `MAIL_BRANDING` port (the platform provides
it) for the brand of the tenant in scope, renders with it, and sets the
sender's name. Templates read `{{ brand.color }}`, `{{ brand.name }}` and
`{{ brand.logoUrl }}` (the logo's absolute URL, `APP_URL` + the public route);
`layout.html` and its Arabic twin show them, the `signature` partial prints the
name. A mail sent outside a tenant gets the defaults (`DEFAULT_MAIL_BRAND`). The
engine is wrapped (`BrandedTemplateEngine`), so a new template or layout needs
nothing to receive `brand`.

## In documents

`DocumentTemplates.render()` adds `brand` to every document's context: `name`,
`color` and `logo`, the logo as a `data:` URL (a document's page loads nothing
else, [documents](documents.md)). The shared `layout.html` draws the top rule,
the logo and the name.

## In the web app

`GET /v1/branding` is read once per session and tenant (the cache is reset on a
tenant switch, so the theme follows): `BrandTheme` sets `--primary`,
`--primary-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground` and
`--ring` on `<html>`, over both the light and the dark theme, and takes them
off again when there is no colour. The tenant switcher shows the logo.

## The operators' lock

`branding.locked` is a flag with no tenant scope: only operators set it,
`PUT /v1/settings/branding.locked/platform { value: true }` for every tenant,
or for some by a platform rule on the tenant's slug
([settings](settings.md), "Targeting rules"):

```json
{ "value": false, "rules": [{ "conditions": [{ "key": "tenantSlug", "params": { "slugs": ["acme"] } }], "outcome": { "value": true } }] }
```

While it is on, `PUT /v1/branding`, the logo routes **and** the settings API
(`PUT` / `DELETE /v1/settings/branding.*`) answer 409 `branding_locked`; what
is stored stays in force and the page shows it read only. To decide the values
instead of freezing them, operators set `branding.primaryColor` or
`branding.mailFromName` at the platform scope with `enforced: true`: it beats
every tenant's value.

## Left out

- The logo does not count toward the tenant's `quotas.maxStorageBytes` (it is at
  most 512 KB and one per tenant; the quota counts attachments).
- No per-user or per-team branding, no dark-mode logo, no custom fonts or
  favicon, and no branding on the sign-in page before a tenant is known.
- Mail sent by an operator for another tenant (a tenant's first invitation)
  carries the operator tenant's brand: the brand is that of the tenant in scope.
