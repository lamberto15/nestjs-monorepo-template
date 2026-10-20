---
'@nestjs-monorepo-template/api-client': minor
---

Enterprise SSO, part 2: `groupsAttribute`, `roleMappings` and `defaultRoleIds` on SSO connections (roles from the IdP's groups, and for just-in-time members); `saml.requireEncryptedAssertions` and `saml.spCertificate` (our certificate: signed AuthnRequests, encrypted assertions); `GET`/`PUT /v1/sso/policy` ("SSO required") and `PUT`/`DELETE /v1/sso/exemptions/{userId}` (break-glass); `POST /v1/auth/sso/discover` (an address's SSO login URL); `managedByScim` on `GET /v1/access/teams`. New problem codes: `sso_required`, `sso_lockout`, `sso_connection_required`, `sso_exemption_needs_mfa`, `team_managed_by_scim`.
