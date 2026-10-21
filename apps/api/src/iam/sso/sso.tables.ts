import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { memberships, roles, teams, userRoles } from '../iam.tables.js';
import type { Oauth2Mapping, Oauth2Preset } from './oauth2-mapping.js';

/**
 * A tenant's enterprise sign-in (docs/auth.md, "Enterprise SSO"): an OpenID
 * Connect, a SAML 2.0 or a plain OAuth 2.0 identity provider of its own. Off until an
 * administrator turns it on. Identities it signs in are keyed
 * `sso:<connection id>` + the IdP's subject in `user_identities`: two
 * tenants' Okta instances never share a key.
 */
export const ssoConnections = pgTable(
  'sso_connections',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    protocol: text('protocol', { enum: ['oidc', 'saml', 'oauth2'] }).notNull(),
    /** Signs people in only when on (an OIDC connection also needs its discovery document). */
    enabled: boolean('enabled').notNull().default(false),
    /**
     * A person of one of the tenant's verified domains who is not a member
     * yet becomes one at their first sign-in (just-in-time), with an account
     * when the address has none. Off: members come from invitations or SCIM.
     */
    jitProvisioning: boolean('jit_provisioning').notNull().default(false),
    // OpenID Connect
    /** The issuer; its discovery document is `<issuer>/.well-known/openid-configuration`. */
    issuer: text('issuer'),
    clientId: text('client_id'),
    /** Encrypted (docs/encryption.md); never returned. */
    clientSecret: encryptedText('client_secret'),
    /** The issuer's discovery document, fetched on the queue, never during a sign-in. */
    oidcMetadata: jsonb('oidc_metadata').$type<Record<string, unknown>>(),
    metadataFetchedAt: at('metadata_fetched_at'),
    /** Why the last fetch failed (null once one succeeds). */
    metadataError: text('metadata_error'),
    // OAuth 2.0 (no OpenID Connect: no discovery, no ID token); clientId and
    // clientSecret above.
    authorizationEndpoint: text('authorization_endpoint'),
    tokenEndpoint: text('token_endpoint'),
    /** Where the person is read from (one GET with the access token). */
    userinfoEndpoint: text('userinfo_endpoint'),
    /** How the client authenticates at the token endpoint (PKCE is always on). */
    tokenEndpointAuthMethod: text('token_endpoint_auth_method', {
      enum: ['client_secret_post', 'client_secret_basic', 'none'],
    }),
    scopes: jsonb('scopes').$type<string[]>(),
    /** Where the user-info answer holds the person (iam/sso/oauth2-mapping.ts). */
    mapping: jsonb('mapping').$type<Oauth2Mapping>(),
    /** The preset whose defaults filled the fields at creation, if any. */
    preset: jsonb('preset').$type<Oauth2Preset>(),
    // SAML 2.0
    /** The IdP's entity id: the assertions' `Issuer`. */
    idpEntityId: text('idp_entity_id'),
    /** Where the AuthnRequest goes (HTTP-Redirect binding). */
    idpSsoUrl: text('idp_sso_url'),
    /** The IdP's signing certificates (PEM): one, or two during a rotation. Public, not secrets. */
    idpCertificates: jsonb('idp_certificates')
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Accept responses no request of ours asked for (a login-CSRF vector): opt-in. */
    allowIdpInitiated: boolean('allow_idp_initiated').notNull().default(false),
    /**
     * Refuse a response whose assertion isn't encrypted to our certificate
     * (`spCertificate`). Off: an encrypted one is decrypted, a plain one
     * accepted (both signed).
     */
    requireEncryptedAssertions: boolean('require_encrypted_assertions')
      .notNull()
      .default(false),
    /**
     * Our key for this connection (PEM, PKCS#8): signs the AuthnRequests and
     * decrypts encrypted assertions. Made with the connection; encrypted
     * (docs/encryption.md), never returned.
     */
    spPrivateKey: encryptedText('sp_private_key'),
    /** Its self-signed certificate (PEM), published in our SP metadata. */
    spCertificate: text('sp_certificate'),
    // SAML and OpenID Connect
    /**
     * Where the IdP lists the person's groups: a SAML attribute's name or an
     * ID token claim (`groups` when null). Read for `sso_role_mappings`.
     * OAuth 2.0 connections name theirs in `mapping.groups`.
     */
    groupsAttribute: text('groups_attribute'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('sso_connections', table, { referenced: true }),
    uniqueIndex('sso_connections_tenant_name_idx').on(
      table.tenantId,
      table.name,
    ),
  ],
).enableRLS();

encrypted(ssoConnections.clientSecret);
encrypted(ssoConnections.spPrivateKey);

/**
 * The roles a connection gives (docs/auth.md, "Roles from the IdP"): with
 * a `group`, to whoever the IdP lists in that group at each sign-in (and
 * taken back when it no longer does); without one, to a member it
 * provisions just in time, once. A role deleted takes its rows with it.
 */
export const ssoRoleMappings = pgTable(
  'sso_role_mappings',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    connectionId: uuid('connection_id').notNull(),
    /** The IdP's group (or claim value), compared exactly; null: a just-in-time member's default role. */
    group: text('group'),
    roleId: uuid('role_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    ...tenantTable('sso_role_mappings', table),
    // A default role (no group) once per connection, too.
    unique('sso_role_mappings_connection_group_role_key')
      .on(table.connectionId, table.group, table.roleId)
      .nullsNotDistinct(),
    index('sso_role_mappings_role_id_idx').on(table.roleId),
    tenantReference(
      'sso_role_mappings_connection_fk',
      [table.tenantId, table.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
    tenantReference(
      'sso_role_mappings_role_fk',
      [table.tenantId, table.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
).enableRLS();

/**
 * The role grants (`user_roles`) a connection's group mapping made: only
 * these are taken back when the IdP stops listing the group. A grant an
 * administrator made stays theirs; one they set again (PATCH the user's
 * roles) rewrites `user_roles` and drops its row here, so it becomes theirs.
 */
export const ssoRoleGrants = pgTable(
  'sso_role_grants',
  {
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index('sso_role_grants_connection_idx').on(
      table.connectionId,
      table.userId,
    ),
    ...tenantTable('sso_role_grants', table),
    foreignKey({
      name: 'sso_role_grants_user_role_fk',
      columns: [table.userId, table.roleId],
      foreignColumns: [userRoles.userId, userRoles.roleId],
    }).onDelete('cascade'),
    tenantReference(
      'sso_role_grants_connection_fk',
      [table.tenantId, table.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
).enableRLS();

/**
 * A tenant's SSO policy (docs/auth.md, "SSO required"): one row, absent
 * until an administrator sets it.
 */
export const ssoPolicies = pgTable(
  'sso_policies',
  {
    tenantId: tenantColumn().primaryKey(),
    /**
     * Its members act in it only through one of its connections: a session
     * signed in otherwise (password, passkey, a link, Google…) or an access
     * token is refused there (403 `sso_required`), save the exempted.
     */
    requireSso: boolean('require_sso').notNull().default(false),
    ...timestamps(),
  },
  (table) => [...tenantTable('sso_policies', table)],
).enableRLS();

/**
 * The break-glass members of a tenant that requires SSO: they may still
 * sign in with their password or passkey (when the IdP is down, or
 * misconfigured). Each use is audited (`sso.exemption-used`).
 */
export const ssoExemptions = pgTable(
  'sso_exemptions',
  {
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    /** Why (shown to the other administrators). */
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    ...tenantTable('sso_exemptions', table),
    foreignKey({
      name: 'sso_exemptions_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
  ],
).enableRLS();

/**
 * The email domains a tenant proved it controls (a DNS TXT record). An SSO
 * connection may assert, and SCIM provision, only addresses of a verified
 * domain: no account of another domain is taken over through a tenant's IdP.
 */
export const ssoDomains = pgTable(
  'sso_domains',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Lower case, no trailing dot. */
    domain: text('domain').notNull(),
    /** What the TXT record must hold; published in DNS, so not a secret. */
    verificationToken: text('verification_token').notNull(),
    verifiedAt: at('verified_at'),
    lastCheckedAt: at('last_checked_at'),
    /** Why the last check failed (null once one succeeds). */
    lastError: text('last_error'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('sso_domains', table),
    uniqueIndex('sso_domains_tenant_domain_idx').on(
      table.tenantId,
      table.domain,
    ),
  ],
).enableRLS();

/**
 * Which tenants verified an email domain: the sign-in page's lookup by
 * address (`POST /v1/auth/sso/discover`), made before there is a tenant,
 * so global (core/tenancy/global-tables.ts), as `memberships`. Kept with
 * `sso_domains` in the same transactions (a verification adds the row, a
 * removal takes it); it holds nothing `sso_domains` doesn't.
 */
export const ssoDomainRoutes = pgTable(
  'sso_domain_routes',
  {
    domain: text('domain').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** When the tenant verified it: of two tenants, the first answers. */
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.domain, table.tenantId] }),
    index('sso_domain_routes_tenant_id_idx').on(table.tenantId),
  ],
);

/**
 * Sign-ins through a connection under way, bound to the browser that
 * started them: the cookie holds a secret whose SHA-256 is `bindingHash`
 * (OIDC's `state` too). One use each (`consumedAt`), short-lived.
 */
export const ssoRequests = pgTable(
  'sso_requests',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    connectionId: uuid('connection_id').notNull(),
    bindingHash: text('binding_hash').notNull(),
    /** OIDC: PKCE's verifier and the ID token's nonce. */
    codeVerifier: text('code_verifier'),
    nonce: text('nonce'),
    /** SAML: the AuthnRequest's ID, which the response's `InResponseTo` names. */
    samlRequestId: text('saml_request_id'),
    /** A path of the web app to land on. */
    redirectTo: text('redirect_to'),
    /** SAML: the account the IdP's response signed in, between the ACS and the sign-in. */
    userId: uuid('user_id'),
    /** When the IdP authenticated the person (`auth_time`, `AuthnInstant`). */
    authenticatedAt: at('authenticated_at'),
    createdAt: at('created_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
    consumedAt: at('consumed_at'),
  },
  (table) => [
    ...tenantTable('sso_requests', table),
    uniqueIndex('sso_requests_tenant_binding_idx').on(
      table.tenantId,
      table.bindingHash,
    ),
    index('sso_requests_connection_saml_idx').on(
      table.connectionId,
      table.samlRequestId,
    ),
    index('sso_requests_expires_at_idx').on(table.expiresAt),
    tenantReference(
      'sso_requests_connection_fk',
      [table.tenantId, table.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
).enableRLS();

/**
 * SAML assertions already used, by their ID, until they expire: a response
 * presented twice (replayed) is refused.
 */
export const ssoAssertions = pgTable(
  'sso_assertions',
  {
    tenantId: tenantColumn(),
    connectionId: uuid('connection_id').notNull(),
    assertionId: text('assertion_id').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.connectionId, table.assertionId],
    }),
    index('sso_assertions_expires_at_idx').on(table.expiresAt),
    ...tenantTable('sso_assertions', table),
    tenantReference(
      'sso_assertions_connection_fk',
      [table.tenantId, table.connectionId],
      [ssoConnections.tenantId, ssoConnections.id],
    ),
  ],
).enableRLS();

/**
 * What a tenant's SCIM client said about a member it provisioned (its
 * `externalId`, the resource it sent): the account stays global and its
 * own (docs/tenancy.md), so the name and address it sends are kept here,
 * never written to the account. Goes with the membership.
 */
export const scimUsers = pgTable(
  'scim_users',
  {
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    externalId: text('external_id'),
    /** The SCIM attributes last written (no `id`, `meta`, `schemas`, `active`). */
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    uniqueIndex('scim_users_tenant_external_id_idx').on(
      table.tenantId,
      table.externalId,
    ),
    ...tenantTable('scim_users', table),
    foreignKey({
      name: 'scim_users_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
  ],
).enableRLS();

/** The teams a tenant's SCIM client manages as groups, with its `externalId`. */
export const scimGroups = pgTable(
  'scim_groups',
  {
    tenantId: tenantColumn(),
    teamId: uuid('team_id').notNull(),
    externalId: text('external_id'),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.teamId] }),
    uniqueIndex('scim_groups_tenant_external_id_idx').on(
      table.tenantId,
      table.externalId,
    ),
    ...tenantTable('scim_groups', table),
    tenantReference(
      'scim_groups_team_fk',
      [table.tenantId, table.teamId],
      [teams.tenantId, teams.id],
    ),
  ],
).enableRLS();
