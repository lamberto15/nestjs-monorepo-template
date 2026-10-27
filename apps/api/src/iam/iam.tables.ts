import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../core/database/columns.js';
import { utcMilliseconds } from '../core/database/utc-milliseconds.js';
import { closureTable } from '../core/database/tree.js';
import { tenants } from '../core/tenancy/tenancy.tables.js';
import {
  optionalTenantColumn,
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../core/tenancy/tenant-scope.js';

// Re-exported: features imported uuidPk from here before it moved to core.
export { uuidPk };

/**
 * Systems that call the API with a key, managed through the access API.
 * Each belongs to one tenant, and acts in it alone (docs/tenancy.md).
 */
export const apiClients = pgTable(
  'api_clients',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    /** Requests a UTC day (platform/usage); past it, 429 quota_exceeded. Null: no quota. */
    dailyQuota: integer('daily_quota'),
    /** CIDRs (normalized, auth/client-ip.ts) the client's keys may be used from; empty: any address. */
    allowedCidrs: text('allowed_cidrs').array().notNull().default([]),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('api_clients', table, { referenced: true }),
    uniqueIndex('api_clients_tenant_name_idx').on(table.tenantId, table.name),
  ],
).enableRLS();

/**
 * An API client's keys: several at once during a rotation, each with an
 * optional expiry. A key is `<prefix>_<keyId>_<secret>`; only its SHA-256 is
 * stored. Global (core/tenancy/global-tables.ts): a key is found by its id
 * before its tenant is known; `tenant_id` says whose it is, and its client
 * (a tenant table) is loaded in that tenant.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuidPk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    /** The key's public id: the middle of `<prefix>_<id>_<secret>`. */
    keyId: text('key_id').notNull().unique(),
    /** The SHA-256 of the whole key, in base64url, as ApiKeyProvider compares it. */
    keyHash: text('key_hash').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    /** After this, the key is refused (a rotation's grace period ends here). */
    expiresAt: at('expires_at'),
    revokedAt: at('revoked_at'),
    /** Updated at most once a minute. */
    lastUsedAt: at('last_used_at'),
  },
  (table) => [
    index('api_keys_client_id_idx').on(table.clientId),
    tenantReference(
      'api_keys_client_fk',
      [table.tenantId, table.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
);

/**
 * People who sign in: with a password, a magic link, or an OAuth provider.
 * Global (docs/tenancy.md): one account per address, whatever tenants it
 * belongs to (`memberships`). Only its owner changes it (their profile,
 * password, sign-in methods); a tenant's administrators manage the
 * membership, never the account.
 */
export const users = pgTable('users', {
  id: uuidPk(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /**
   * scrypt, from PasswordHasher. Never leaves UsersRepository. Null for an
   * invited user who hasn't set one yet, or one who only signs in with a
   * provider.
   */
  passwordHash: text('password_hash'),
  /** The owner proved the address (a verification, reset or invitation link, or the provider). */
  emailVerified: boolean('email_verified').notNull().default(false),
  /** The language the user chose (one of LOCALES); null: the request's. */
  locale: text('locale'),
  /** The user's IANA time zone (`Europe/Berlin`); null: APP_TIMEZONE. */
  timezone: text('timezone'),
  active: boolean('active').notNull().default(true),
  /**
   * First administrator's onboarding (docs/auth.md, "Administrator
   * onboarding"): the seeded address is a placeholder (or unproved) and must
   * be replaced by a real, verified one. Cleared once it is. False for
   * everyone else.
   */
  onboardingEmail: boolean('onboarding_email').notNull().default(false),
  /** Likewise: the seeded password was generated and must be changed. */
  onboardingPassword: boolean('onboarding_password').notNull().default(false),
  /**
   * The picture's file on the private disk (`accounts/<id>/avatar/<uuid>.<ext>`,
   * PUT /v1/account/avatar); null: none. Read as `avatarUrl`, never as a key.
   */
  avatarKey: text('avatar_key'),
  /**
   * When an identity provider's deprovisioning (SCIM) ended the account's
   * last active membership and so deactivated it; null otherwise. Only an
   * account deactivated this way comes back when a membership does
   * (docs/auth.md, "SCIM provisioning"): never a deleted one.
   */
  deprovisionedAt: at('deprovisioned_at'),
  ...timestamps(),
});

/**
 * The hashes of an account's previous passwords (`auth.passwordHistory`,
 * docs/auth.md, "Passwords"): kept only while a tenant of the account asks
 * for a history, pruned to the count it needs, so a new password can be
 * refused when it repeats one. Hashes only, from the account's hasher;
 * never exported. The current password's hash is `users.password_hash`.
 * Global, like the account.
 */
export const passwordHistory = pgTable(
  'password_history',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    /** When the password was replaced. */
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('password_history_user_id_idx').on(table.userId, table.createdAt),
  ],
);

/**
 * Which tenants a user belongs to, and whether the membership is active:
 * what lets the user act in a tenant at all. Global (core/tenancy/global-tables.ts):
 * a sign-in picks the session's tenant from them, `GET /v1/auth/tenants`
 * lists them, the switch checks one; a tenant's administrators read and
 * change only their own tenant's (`tenant_id` filtered in code). What a
 * membership may do is in tenant tables: its roles (`user_roles`) and org
 * teams (`user_teams`), whose keys reference it.
 */
export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Off: the user can't act in this tenant (a session in it has no tenant until they switch). */
    active: boolean('active').notNull().default(true),
    /** When the user last chose this tenant: a new sign-in starts in the latest. */
    selectedAt: at('selected_at'),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index('memberships_user_id_idx').on(table.userId),
  ],
);

/**
 * Invitations to a tenant (docs/tenancy.md, "Invitations"): an address, the
 * roles and teams its membership will have, and the link's token (only its
 * SHA-256). Nothing about an account is read or changed until the person
 * accepts: a new address chooses a password with the link; an existing
 * account accepts while signed in. A tenant table: the token names its
 * tenant, so it is looked up in that tenant's scope.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Normalized, as `users.email`. */
    email: text('email').notNull(),
    /** The name a new account starts with (its owner changes it). */
    name: text('name'),
    roleIds: jsonb('role_ids').$type<string[]>().notNull().default([]),
    /** When each grant ends, by role id. */
    roleExpiresAt: jsonb('role_expires_at')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    teamIds: jsonb('team_ids').$type<string[]>().notNull().default([]),
    /** The SHA-256 of the link's secret, base64url. */
    tokenHash: text('token_hash').notNull(),
    /** `user:<id>` of who invited. */
    invitedBy: text('invited_by').notNull(),
    expiresAt: at('expires_at').notNull(),
    acceptedAt: at('accepted_at'),
    acceptedBy: uuid('accepted_by'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('invitations', table),
    uniqueIndex('invitations_tenant_token_idx').on(
      table.tenantId,
      table.tokenHash,
    ),
    index('invitations_tenant_email_idx').on(table.tenantId, table.email),
  ],
).enableRLS();

/**
 * Accounts at OAuth / OpenID Connect providers, linked to a user: by
 * (provider, subject), never by email.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.subject] }),
    index('user_identities_user_id_idx').on(table.userId),
  ],
);

/**
 * A user's passkeys (WebAuthn credentials; docs/auth.md, "Passkeys"), each
 * named by its owner. The credential id and the public key are what the
 * authenticator made; the counter guards against a cloned authenticator
 * (synced passkeys keep it at 0). Credentials belong to the person, not to
 * a tenant (roadmap 1a: users are global).
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What the user calls it ("MacBook", "YubiKey 5C"). */
    name: text('name').notNull(),
    /** The credential id, base64url, as the authenticator reports it. */
    credentialId: text('credential_id').notNull().unique(),
    /** The COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    /** The signature counter last seen; a response with a lower one is refused. */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    /** How the browser can reach the authenticator (`internal`, `hybrid`, `usb`…). */
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    /** `multiDevice`: a synced passkey (iCloud Keychain, Google Password Manager); `singleDevice`: bound to one authenticator. */
    deviceType: text('device_type', {
      enum: ['singleDevice', 'multiDevice'],
    }).notNull(),
    /** Whether the passkey is backed up (synced) right now. */
    backedUp: boolean('backed_up').notNull().default(false),
    /** The authenticator model's id (all zeros with `none` attestation on many platforms). */
    aaguid: text('aaguid').notNull().default(''),
    lastUsedAt: at('last_used_at'),
    ...timestamps(),
  },
  (table) => [index('passkeys_user_id_idx').on(table.userId)],
);

// Authentication state that DrizzleAuthenticationStore keeps for
// @nestjs/authentication (the tables of the NestJS docs). Tokens, links and
// sessions are stored by their SHA-256; TOTP secrets arrive encrypted.

/**
 * Sessions, by the SHA-256 of their cookie token. Global: a session is the
 * person's; its tenant is `metadata.tenantId` (set at sign-in, changed only
 * by re-issuing the session: POST /v1/auth/tenant).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    lastActiveAt: at('last_active_at').notNull(),
    mfa: text('mfa', { enum: ['pending', 'verified'] }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/** Roles managed through the access API, per tenant. A system role can't be changed or deleted. */
export const roles = pgTable(
  'roles',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The code's name for a built-in or seeded role (`administrator`, `editor`); null for roles made in the API. */
    key: text('key'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    system: boolean('system').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('roles', table, { referenced: true }),
    uniqueIndex('roles_tenant_key_idx').on(table.tenantId, table.key),
    uniqueIndex('roles_tenant_name_idx').on(table.tenantId, table.name),
  ],
).enableRLS();

/** One condition of a permission: a template of the permission catalog, with its parameters. */
export interface PermissionCondition {
  key: string;
  params?: Record<string, unknown>;
}

/** What a role allows: an action on a subject, when every condition holds. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    roleId: uuid('role_id').notNull(),
    subject: text('subject').notNull(),
    action: text('action').notNull(),
    conditions: jsonb('conditions')
      .$type<PermissionCondition[]>()
      .notNull()
      .default([]),
    /** Only these declared fields of the subject; null: all of them. */
    fields: jsonb('fields').$type<string[]>(),
  },
  (table) => [
    ...tenantTable('role_permissions', table),
    index('role_permissions_role_id_idx').on(table.roleId),
    tenantReference(
      'role_permissions_role_fk',
      [table.tenantId, table.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
).enableRLS();

/**
 * A membership's roles: a user's roles in a tenant. A grant with
 * `expiresAt` stops counting then (temporary access).
 */
export const userRoles = pgTable(
  'user_roles',
  {
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    expiresAt: at('expires_at'),
  },
  (table) => [
    // A role belongs to one tenant, so (user, role) names the grant.
    primaryKey({ columns: [table.userId, table.roleId] }),
    index('user_roles_role_id_idx').on(table.roleId),
    // The roles list counts each role's live grants (access-admin.service.ts, roleViews): role, the RLS
    // predicate's tenant and the expiry in one index, so the count is an index-only scan.
    index('user_roles_role_live_idx').on(
      table.roleId,
      table.tenantId,
      table.expiresAt,
    ),
    ...tenantTable('user_roles', table),
    foreignKey({
      name: 'user_roles_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    tenantReference(
      'user_roles_role_fk',
      [table.tenantId, table.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
).enableRLS();

/** An API client's roles, on top of the permissions every client has; they can expire too. */
export const apiClientRoles = pgTable(
  'api_client_roles',
  {
    tenantId: tenantColumn(),
    clientId: uuid('client_id').notNull(),
    roleId: uuid('role_id').notNull(),
    expiresAt: at('expires_at'),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.roleId] }),
    index('api_client_roles_role_id_idx').on(table.roleId),
    ...tenantTable('api_client_roles', table),
    tenantReference(
      'api_client_roles_client_fk',
      [table.tenantId, table.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
    tenantReference(
      'api_client_roles_role_fk',
      [table.tenantId, table.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
).enableRLS();

/**
 * Who did what: sign-ins, access changes and sensitive actions. Append-only.
 * Per tenant (the tenant of the work that recorded it); an account's own
 * entries made outside any tenant (sign-ins, sign-ups, password resets)
 * have none, and only work outside a tenant reads them (docs/tenancy.md).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuidPk(),
    tenantId: optionalTenantColumn(),
    at: at('at').notNull().defaultNow(),
    /** `user:<id>`, `client:<id>`, or `anonymous`. */
    actor: text('actor').notNull(),
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ip: text('ip'),
  },
  (table) => [
    index('audit_log_at_idx').on(table.at),
    index('audit_log_tenant_at_ms_id_idx').on(
      table.tenantId,
      sql`${utcMilliseconds(table.at)} desc nulls first`,
      table.id.desc().nullsFirst(),
    ),
    index('audit_log_tenant_id_id_idx').on(table.tenantId, table.id),
    // One actor's entries of one kind, recent first: a sign-in looks up the account's known devices.
    index('audit_log_actor_action_at_idx').on(
      table.actor,
      table.action,
      table.at,
    ),
    // One record's history (?targetId=) and the account export's entries about
    // a person in a tenant they left (target_type 'user'), newest first.
    index('audit_log_target_id_id_idx').on(table.targetId, table.id),
    // One actor's entries in id order: ?actor=, the account export's keyset
    // pages (AccountTransfer.auditEntries), the deletion's relabel.
    index('audit_log_actor_id_idx').on(table.actor, table.id),
    // ?action= within the tenant, newest first.
    index('audit_log_tenant_action_id_idx').on(
      table.tenantId,
      table.action,
      table.id,
    ),
    ...tenantTable('audit_log', table, { nullRows: 'outside' }),
  ],
).enableRLS();

/** Refresh tokens of the token clients (mobile apps, CLIs), by SHA-256. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull(),
    userId: text('user_id').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    familyExpiresAt: at('family_expires_at').notNull(),
    usedAt: at('used_at'),
    // A family is revoked when any of its tokens is: that covers a successor saved after the revocation.
    revoked: boolean('revoked').notNull().default(false),
    claims: jsonb('claims').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('refresh_tokens_family_id_idx').on(table.familyId),
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_family_expires_at_idx').on(table.familyExpiresAt),
  ],
);

/** Each user's authenticator app (TOTP), its secret encrypted. */
export const mfaAuthenticators = pgTable('mfa_authenticators', {
  userId: text('user_id').primaryKey(),
  secret: text('secret').notNull(),
  confirmed: boolean('confirmed').notNull(),
  pendingSecret: text('pending_secret'),
  lastUsedStep: integer('last_used_step'),
});

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    userId: text('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.codeHash] })],
);

export const mfaFailures = pgTable(
  'mfa_failures',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id').notNull(),
    failedAt: at('failed_at').notNull(),
  },
  (table) => [
    index('mfa_failures_user_id_failed_at_idx').on(
      table.userId,
      table.failedAt,
    ),
    index('mfa_failures_failed_at_idx').on(table.failedAt),
  ],
);

export const magicLinks = pgTable(
  'magic_links',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    redirectTo: text('redirect_to'),
  },
  (table) => [index('magic_links_expires_at_idx').on(table.expiresAt)],
);

/** OAuth / OpenID Connect sign-ins in progress. */
export const oidcLogins = pgTable(
  'oidc_logins',
  {
    state: text('state').primaryKey(),
    provider: text('provider').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce'),
    redirectTo: text('redirect_to'),
    // Set for "connect your Google account" from a signed-in session.
    linkUserId: text('link_user_id'),
    linkSessionId: text('link_session_id'),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (table) => [index('oidc_logins_expires_at_idx').on(table.expiresAt)],
);

/** Password reset, invitation and email verification links. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose', {
      enum: ['password-reset', 'email-verification'],
    }).notNull(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    fingerprint: text('fingerprint'),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (table) => [
    index('email_tokens_user_id_purpose_idx').on(table.userId, table.purpose),
    index('email_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * The organization of a tenant: teams in a tree (company, department,
 * team). Users belong to teams; records can carry the team that owns them,
 * and the `inMyTeams` condition grants what is in a user's teams and below.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    /** Null: a top-level team. The closure table (team_tree) holds every path. */
    parentId: uuid('parent_id'),
    ...timestamps(),
  },
  (table) => [
    index('teams_parent_id_idx').on(table.parentId),
    ...tenantTable('teams', table, { referenced: true }),
    tenantReference(
      'teams_parent_fk',
      [table.tenantId, table.parentId],
      [table.tenantId, table.id],
      'restrict',
    ),
  ],
).enableRLS();

/** Every (ancestor, descendant) pair of teams: "under X" at any depth in one lookup. */
export const teamTree = closureTable('team_tree', () => teams);

/** Which teams a member belongs to. */
export const userTeams = pgTable(
  'user_teams',
  {
    tenantId: tenantColumn(),
    userId: uuid('user_id').notNull(),
    teamId: uuid('team_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.teamId] }),
    index('user_teams_team_id_idx').on(table.teamId),
    ...tenantTable('user_teams', table),
    foreignKey({
      name: 'user_teams_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    tenantReference(
      'user_teams_team_fk',
      [table.tenantId, table.teamId],
      [teams.tenantId, teams.id],
    ),
  ],
).enableRLS();

/**
 * Break-glass grants (docs/tenancy.md, "Break-glass"): an operator's
 * read-only access to a tenant that never invited them, for at most an
 * hour, with the reason they gave. A row of the operators' tenant (the
 * grant is theirs: `tenant_id`), naming the tenant it opens
 * (`target_tenant_id`, a global table's key: the grant outlives nothing
 * of it). Read on every request that uses it (BreakGlassGuard), in the
 * operators' tenant, before the request moves to the other one.
 */
export const breakGlassGrants = pgTable(
  'break_glass_grants',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The operator who opened it; nobody else uses it. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetTenantId: uuid('target_tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Why, in the operator's words: kept with the grant and in both tenants' audit entries. */
    reason: text('reason').notNull(),
    /** At most an hour after it was opened; never extended (a new grant needs a new reason). */
    expiresAt: at('expires_at').notNull(),
    /** Ended before its time by the operator (`DELETE …/break-glass/{id}`). */
    endedAt: at('ended_at'),
    ...timestamps(),
  },
  (table) => [
    ...tenantTable('break_glass_grants', table),
    index('break_glass_grants_user_target_idx').on(
      table.tenantId,
      table.userId,
      table.targetTenantId,
    ),
  ],
).enableRLS();
