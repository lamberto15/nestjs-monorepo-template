# Tenant branding

A tenant's colour, logo and sender name, shown by the web app, the mail the
tenant sends and its PDF documents. The code is in
`apps/api/src/platform/branding/` (and `core/mail/mail-branding.ts`); the page
is `/branding` in the web app (`apps/web/src/features/branding`).

| What | Where it lives | Shown in |
| --- | --- | --- |
| `branding.primaryColor`: `#rrggbb` | a tenant setting ([settings](settings.md)) | the web theme, mail (the card's top edge), documents (the page's top rule and name) |
| `branding.darkPrimaryColor`: `#rrggbb`, optional | a tenant setting | the web theme in dark mode only (absent: `primaryColor`) |
| `branding.mailFromName` | a tenant setting | the sender's display name of every mail, and its signature; documents show it under the logo |
| the logo: PNG, JPEG or WebP, 512 KB | the private disk, `tenants/<id>/branding/logo` ([attachments](attachments.md) for the disk) | the menu's tenant switcher, mail, documents |
| the dark-mode logo: same types and size, optional | the private disk, `tenants/<id>/branding/logo-dark-<uuid>` | the menu's tenant switcher in dark mode only (absent: the logo) |
| `branding.locked` | a flag the operators set | refuses changes, below |

The colour and the name are ordinary settings, so they are audited as
`setting.updated` / `setting.reset`, cached per tenant and readable at
`GET /v1/settings`; the branding routes below are a shortcut over them, with
the same schemas. The logo is a file, not a setting: its key is built from the
request's tenant (never from the client), so no value can point at another
tenant's file.

## Routes

```
GET    /v1/branding                    { primaryColor, darkPrimaryColor, mailFromName, logoUrl, darkLogoUrl, locked, canEdit }   any signed-in caller
PUT    /v1/branding                    { primaryColor?, darkPrimaryColor?, mailFromName? }   null removes, absent stays   Access.manageSettings
POST   /v1/branding/logo               multipart, field `file`   201, the branding   Access.manageSettings
DELETE /v1/branding/logo               204   Access.manageSettings
POST   /v1/branding/logo/dark          the dark-mode logo, as the logo   Access.manageSettings
DELETE /v1/branding/logo/dark          204   Access.manageSettings
GET    /v1/branding/{tenantId}/logo    the image, cached 5 minutes   no sign-in
GET    /v1/branding/{tenantId}/logo/dark   the dark-mode image, as the logo   no sign-in
GET    /v1/branding/host               the brand of the request's host, before sign-in   no sign-in
GET    /v1/branding/domains            { enabled, domains }   Access.manageDomains
POST   /v1/branding/domains            { hostname }   201, the domain and its TXT record   Access.manageDomains
POST   /v1/branding/domains/{id}/verify   202, the DNS check queued   Access.manageDomains
DELETE /v1/branding/domains/{id}       204, stops routing at once   Access.manageDomains
```

The custom domains' routes are for people (no API keys), and their writes
want a recent sign-in, as SSO's domains do (below, "Custom domains").

`logoUrl` is the path of the last route. It is public on purpose: a mail client
and the sign-in page show it without a session, and the logo is in every mail
the tenant sends. It reveals nothing but the image, to someone who has the
tenant's id. The route serves the bytes itself (no redirect, so no URL is built
from the request): the key comes from the id the database answers for an
**active** tenant, never from the one in the path; the `Content-Type` is the
one the first bytes say, from the allowlist, whatever the stored metadata
says; and the response carries `nosniff`, `Content-Security-Policy:
default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: cross-origin`.

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
  never replaces the logo that is there. The bytes are checked again every time
  the logo is read (served, put in a mail, embedded in a PDF): a file on the key
  that is not one of the three is not a logo (404, none in the mail).
- **The dark-mode logo and colour** take the very same checks (the same
  signature detection, allowlist, size, lock and public-route headers; the
  same `#rrggbb` schema). Mail and documents never use them: a mail client has
  no theme, and a PDF is light.
- **Stored values are checked again where they are used** (`safeColor`,
  `safeName`): a colour or a name that the schemas would refuse (an enforced
  platform value, a row written by hand) is dropped, never escaped into a style
  or a header.

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
off again when there is no colour. In the dark theme (chosen, or the system's
when it follows it) the colour is `darkPrimaryColor` when the tenant has one,
else `primaryColor`; the tenant switcher likewise shows `darkLogoUrl` when
there is one, else the logo.

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

## Custom domains

With `CUSTOM_DOMAINS=on` (off by default: the edge must serve them,
[deployment](deployment.md#custom-domains-on-demand-tls)), a tenant's
people may reach the app on a hostname of its own (`app.acme.com`), with its
logo and colour from the sign-in page on. The code is
`platform/branding/branding-domains.*`; the page is the Custom domains
section of `/branding` (with `Access.manageDomains`).

1. **Add the hostname** (`POST /v1/branding/domains`, audited
   `branding.domain-added`). It is checked as a public FQDN
   (`platform/branding/hostname.ts`): trimmed, lower-cased, without the
   trailing dot, an internationalized name in punycode (`domainToASCII`),
   two labels at least, labels of 63 and 253 characters in all, a top-level
   name that is letters or `xn--`. Refused (400 `invalid_hostname`): an IP
   address in any spelling (`10.0.0.1`, `[::1]`, `0x7f.1`), a port, a scheme,
   a path, a user, a wildcard, a reserved top-level name (`.local`,
   `.localhost`, `.internal`, `.test`, `.example`, `.invalid`, `.onion`,
   `.arpa`, `.home`, `.lan`, `.corp`), and the app's own domain or one under
   it (APP_URL's and WEB_URL's hosts). Unique per tenant (409
   `domain_exists`), not across tenants: listing a hostname proves nothing,
   so it blocks nobody.
2. **Point it at the app** (a CNAME to `APP_DOMAIN`) and **publish the TXT
   record** the answer gives: `_app-verification.<hostname>` holding
   `app-verification=<token>` (the token is the domain's own, random).
3. **Verify** (`POST …/{id}/verify`, 202): the lookup runs on the
   `custom-domains` queue, never in the request (`system:custom-domains`).
   Found, the domain is verified (audited `branding.domain-verified`) and
   routes to the tenant in `tenant_domain_routes`, a global table read
   before there is a tenant ([tenancy](tenancy.md)). One tenant per
   hostname: the first to prove it; another that publishes its own record
   too gets `lastError: Another tenant uses this domain.` until the first's
   record goes.

**Verified only while the record resolves.** Every night (02:15,
`BrandingDomainsJob`) each verified domain is looked up again. The record
gone or changed (the domain changed hands, the tenant took it down): the
domain is suspended (audited `branding.domain-suspended`) and its route goes
in the same transaction. A lookup that failed (a timeout, a server failure)
records the error and changes nothing else: a DNS outage doesn't take
domains away. A suspended domain is verified again by a check, once its
record is back.

**What a verified host does**, read at every request on it, never cached
(so a domain removed or suspended stops at once, on every replica). Only a
hostname nobody routes is remembered, for 30 s in Redis
(`custom-domains:unknown:<hostname>`): a flood of requests or TLS asks for
the same unknown name reads the database once. Verifying a domain forgets
its entry; a tenant reactivated waits those 30 s at most. On such a host:

- **The brand before sign-in.** `GET /v1/branding/host` answers the brand
  (the colours, the sender name, the logos' paths) of the tenant whose
  domain the request's `Host` is; the web app's pages before sign-in show
  the logo and name and put the colour on the theme (`useHostBrand`). The
  host is the request's own `Host` header, never a parameter and never
  `X-Forwarded-Host`, so a page learns only the brand of the domain it is
  on. Any other host (the app's own, an unknown or removed domain, an IP,
  a deactivated tenant's) gets every field null: the same answer, no tenant
  named. `Cache-Control: no-store`.
- **The session's tenant.** On a tenant's host a session acts in that
  tenant when its user is a member of it, else in none (the tenant tables
  out of reach), whatever tenant it was switched to (`SessionAuth`, through
  the `HOST_TENANTS` port the platform provides). The host only narrows
  what a membership allows; it never grants one. An impersonation started in
  another tenant ends there. Access tokens and API keys are not bound to a
  host (no ambient credential to misuse).
- **Origins and cookies.** The web app and the API share the custom host,
  as they share `APP_DOMAIN`: requests are same-origin, so the CSRF check
  passes them as it does on the app's host. Custom domains are never added
  to `CORS_ORIGINS` or the trusted origins: a page on one tenant's domain
  can't write to the app's host or another tenant's. The session cookie is
  host-only (`__Host-sid`, no `Domain`), so a sign-in on a custom host is a
  session of that host alone.
- **SSO stays on APP_URL.** SAML and OpenID Connect URLs (the sign-in, the
  assertion consumer service, the redirect URIs) are built from `APP_URL`,
  never from the `Host`: an IdP registration holds whatever host people sign
  in on. A sign-in through SSO ends on the app's own host (left out below).
- **The edge's TLS question.** `GET /v1/internal/domains/allowed?domain=`
  (not in the OpenAPI document) answers 200 for a verified domain of an
  active tenant, else 404: Caddy's on-demand TLS `ask` and its per-request
  check ([deployment](deployment.md#custom-domains-on-demand-tls)). Rate
  limited per address in a bucket of its own (600 a minute, then 429): the
  TLS asks count against the edge's address, the per-request checks against
  the visitor's (`X-Forwarded-For` from the private network).

**Removing** a domain (`DELETE …/{id}`, audited `branding.domain-removed`)
deletes it and its route in one transaction: from the commit on, the host has
no brand, no session pinned to it and no certificate or request from the
edge. Removing is allowed while the operators lock the branding (it only
narrows what is served); adding and verifying answer 409 `branding_locked`.
`CUSTOM_DOMAINS=off` answers 404 `custom_domains_off` to adding and
verifying, and every host is the app's (the list still reads, with
`enabled: false`; the web hides the section).

**Safe assets.** A custom host serves the same logo route
(`/v1/branding/{tenantId}/logo`, with its headers above) and the web app's
own files under the same Content-Security-Policy; nothing a tenant uploads
is served from its domain but its checked logos.

## Left out

- The logo does not count toward the tenant's `quotas.maxStorageBytes` (it is at
  most 512 KB and one per tenant; the quota counts attachments).
- No per-user or per-team branding, no custom fonts or favicon, no dark-mode
  variant in mail or documents, and no branding on the sign-in page of the
  app's own host (only a custom domain's, above).
- On a custom domain: SSO sign-in (it returns to `APP_URL`; the hand-over
  back to the custom host with a one-time code is not built), passkeys (their
  relying party is `PASSKEY_RP_ID`, the app's domain) and mail links (they go
  to `WEB_URL`). Passwords and two-factor work there.
- Mail sent by an operator for another tenant (a tenant's first invitation)
  carries the operator tenant's brand: the brand is that of the tenant in scope.
