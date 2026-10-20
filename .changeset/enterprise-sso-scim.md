---
'@nestjs-monorepo-template/api-client': minor
---

Enterprise SSO: a tenant's SAML and OpenID Connect connections (`GET/POST /v1/sso/connections`, `GET/PATCH/DELETE /v1/sso/connections/{id}`, `POST …/{id}/refresh`) and verified email domains (`GET/POST /v1/sso/domains`, `POST /v1/sso/domains/{id}/verify`, `DELETE /v1/sso/domains/{id}`), with the browser routes under `/v1/auth/sso/{tenantId}/{connectionId}`. SCIM 2.0 provisioning at `/v1/scim` (`Users`, `Groups`, `ServiceProviderConfig`, `ResourceTypes`). New permissions `Access.manageSso` and `Access.provisionScim`; sessions may now report `method: "sso"`.
