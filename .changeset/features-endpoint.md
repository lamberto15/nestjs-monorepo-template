---
'@nestjs-monorepo-template/api-client': minor
---

`GET /v1/features` says which deployment switches are on, for a client that
hides what is turned off: `realtime`, `webhooks`, `reports`, `usage`,
`impersonation`, `mfa`, `apiClients`, `passkeys`, `signUp`, `magicLink`,
`documents`, `tenancy` and `locales`. Any signed-in caller may read it.
