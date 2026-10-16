import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../core/database/columns.js';
import { closureTable } from '../core/database/tree.js';

// Re-exported: features imported uuidPk from here before it moved to core.
export { uuidPk };

/** Systems that call the API with a key, managed through the access API. */
export const apiClients = pgTable('api_clients', {
  id: uuidPk(),
  name: text('name').notNull().unique(),
  active: boolean('active').notNull().default(true),
  /** Requests a UTC day (platform/usage); past it, 429 quota_exceeded. Null: no quota. */
  dailyQuota: integer('daily_quota'),
  ...timestamps(),
});

/**
 * An API client's keys: several at once during a rotation, each with an
 * optional expiry. A key is `<prefix>_<keyId>_<secret>`; only its SHA-256 is
 * stored.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuidPk(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
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
  (table) => [index('api_keys_client_id_idx').on(table.clientId)],
);

/** People who sign in: with a password, a magic link, or an OAuth provider. */
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
  ...timestamps(),
});

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

// Authentication state that DrizzleAuthenticationStore keeps for
// @nestjs/authentication (the tables of the NestJS docs). Tokens, links and
// sessions are stored by their SHA-256; TOTP secrets arrive encrypted.

/** Sessions, by the SHA-256 of their cookie token. */
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

/** Roles managed through the access API. A system role can't be changed or deleted. */
export const roles = pgTable('roles', {
  id: uuidPk(),
  /** The code's name for a built-in or seeded role (`administrator`, `editor`); null for roles made in the API. */
  key: text('key').unique(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  system: boolean('system').notNull().default(false),
  ...timestamps(),
});

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
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    action: text('action').notNull(),
    conditions: jsonb('conditions')
      .$type<PermissionCondition[]>()
      .notNull()
      .default([]),
    /** Only these declared fields of the subject; null: all of them. */
    fields: jsonb('fields').$type<string[]>(),
  },
  (table) => [index('role_permissions_role_id_idx').on(table.roleId)],
);

/** A user's roles. A grant with `expiresAt` stops counting then (temporary access). */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    expiresAt: at('expires_at'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

/** An API client's roles, on top of the permissions every client has; they can expire too. */
export const apiClientRoles = pgTable(
  'api_client_roles',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    expiresAt: at('expires_at'),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.roleId] })],
);

/** Who did what: sign-ins, access changes and sensitive actions. Append-only. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuidPk(),
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
    // One actor's entries of one kind, recent first: a sign-in looks up the account's known devices.
    index('audit_log_actor_action_at_idx').on(
      table.actor,
      table.action,
      table.at,
    ),
  ],
);

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
 * The organization: units in a tree (company, department, team). Users
 * belong to units; records can carry the unit that owns them, and the
 * `inMyUnits` condition grants what is in a user's units and below.
 */
export const orgUnits = pgTable(
  'org_units',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    /** Null: a top-level unit. The closure table (org_unit_tree) holds every path. */
    parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, {
      onDelete: 'restrict',
    }),
    ...timestamps(),
  },
  (table) => [index('org_units_parent_id_idx').on(table.parentId)],
);

/** Every (ancestor, descendant) pair of org units: "under X" at any depth in one lookup. */
export const orgUnitTree = closureTable('org_unit_tree', () => orgUnits.id);

/** Which units a user belongs to. */
export const userOrgUnits = pgTable(
  'user_org_units',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.orgUnitId] }),
    index('user_org_units_org_unit_id_idx').on(table.orgUnitId),
  ],
);
