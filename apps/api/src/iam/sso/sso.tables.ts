import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { memberships, teams } from '../iam.tables.js';

/**
 * A tenant's enterprise sign-in (docs/auth.md, "Enterprise SSO"): an OpenID
 * Connect or a SAML 2.0 identity provider of its own. Off until an
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
    protocol: text('protocol', { enum: ['oidc', 'saml'] }).notNull(),
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
