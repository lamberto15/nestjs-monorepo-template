---
'@nestjs-monorepo-template/api-client': minor
---

Enterprise SSO: plain OAuth 2.0 connections (`protocol: "oauth2"`, for providers without OpenID Connect such as Lark/Feishu) on `POST /v1/sso/connections` and `PATCH /v1/sso/connections/{id}`: `authorizationEndpoint`, `tokenEndpoint`, `userinfoEndpoint`, `clientId`, `clientSecret`, `tokenEndpointAuthMethod`, `scopes`, a declarative `mapping` of the user-info answer, and `preset` (`{ name: "lark", region }`) on creation. Connections answer an `oauth2` block (`null` for the other protocols) and `protocol` may be `oauth2`. The provider sends the browser back to `GET /v1/auth/sso/{tenantId}/{connectionId}/oauth2/callback`. `POST /v1/sso/connections/{id}/refresh` answers 409 `sso_no_discovery` for an OAuth 2.0 connection.
