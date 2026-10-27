import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq, inArray, type SQL, sql } from 'drizzle-orm';
import {
  patchBodyValidation,
  type ScimPatch,
  scimPatch,
  type ScimPatchOperation,
} from 'scim-patch';
import { z } from 'zod';
import type { CoreEnv } from '../../../core/config/core.env.js';
import type { Transaction } from '../../../core/database/drizzle.js';
import {
  pgErrorCode,
  UNIQUE_VIOLATION,
} from '../../../core/database/errors.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../../core/database/transactions.js';
import { Tenancy } from '../../../core/tenancy/tenancy.service.js';
import { AccessAdminService } from '../../access/access-admin.service.js';
import { AccessService } from '../../access/access.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import { UserLifecycleRegistry } from '../../auth/user-lifecycle.registry.js';
import {
  type EndedCredentials,
  normalizeEmail,
  UsersRepository,
} from '../../auth/users.repository.js';
import { memberships, users } from '../../iam.tables.js';
import { emailDomain, SsoDomainsService } from '../sso-domains.service.js';
import { scimUsers } from '../sso.tables.js';
import { SCIM_SCHEMA, ScimException } from './scim-error.filter.js';
import { scimFilter, scimPage } from './scim-filter.js';

/** Azure's `"True"`/`"False"` too: what a PATCH of `active` carries from some IdPs. */
const scimBoolean = z.preprocess(
  (value) =>
    typeof value === 'string' && /^(true|false)$/i.test(value)
      ? value.toLowerCase() === 'true'
      : value,
  z.boolean(),
);

/**
 * A SCIM User as an IdP writes it (RFC 7643 §4.1): `userName` required;
 * the core attributes this API reads checked, the rest (and the
 * enterprise extension) kept as sent, in `scim_users.attributes`.
 */
export const scimUserSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  userName: z.string().trim().min(1).max(320),
  externalId: z.string().max(512).nullish(),
  active: scimBoolean.optional(),
  displayName: z.string().max(200).nullish(),
  name: z
    .looseObject({
      formatted: z.string().max(200).nullish(),
      givenName: z.string().max(200).nullish(),
      familyName: z.string().max(200).nullish(),
    })
    .nullish(),
  emails: z
    .array(
      z.looseObject({
        value: z.string().max(320),
        primary: scimBoolean.optional(),
        type: z.string().max(50).nullish(),
      }),
    )
    .max(20)
    .nullish(),
});
export type ScimUserInput = z.infer<typeof scimUserSchema>;

/** What is never stored: the server's own attributes, and those with a column. */
const NOT_STORED = new Set(['id', 'meta', 'schemas', 'active', 'externalId']);

interface Row {
  userId: string;
  externalId: string | null;
  attributes: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  active: boolean;
}

/**
 * SCIM 2.0 Users (RFC 7644) of the caller's tenant: the members its
 * identity provider provisions (docs/auth.md, "SCIM provisioning").
 *
 * - Create: an address of a domain the tenant verified only. The account
 *   with that address is linked (when its own address is proved: else
 *   whoever registered it first would join the tenant) or made (no
 *   password: it signs in through the tenant's SSO), and its membership
 *   made or reactivated.
 * - `active: false` or DELETE deprovisions: the membership is deactivated,
 *   that tenant's sessions and tokens end, and what waits on the person
 *   moves on (the user lifecycle listeners), as an administrator's
 *   deactivation does. Its other tenants are untouched; when no active
 *   membership remains anywhere, the account is deactivated (never
 *   deleted), and provisioning or `active: true` brings it back.
 * - Only users the SCIM client provisioned (a `scim_users` row) are its:
 *   others' members are neither listed nor changed.
 * - SCIM never changes an account's address or name: they are the
 *   person's, across tenants. What the IdP sends is kept and answered.
 */
@Injectable()
export class ScimUsersService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly domains: SsoDomainsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly accessAdmin: AccessAdminService,
    private readonly lifecycle: UserLifecycleRegistry,
    private readonly tenancy: Tenancy,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  async list(query: { filter?: string; startIndex?: number; count?: number }) {
    const where = scimFilter(query.filter, {
      id: { column: scimUsers.userId, uuid: true },
      userName: {
        column: this.userNameColumn(),
        caseInsensitive: true,
      },
      externalId: { column: scimUsers.externalId },
      'emails.value': { column: users.email, caseInsensitive: true },
      active: { column: memberships.active },
    });
    const page = scimPage(query.startIndex, query.count);
    const [rows, [{ total }]] = await Promise.all([
      page.limit
        ? this.select(where)
            .orderBy(asc(scimUsers.createdAt), asc(scimUsers.userId))
            .limit(page.limit)
            .offset(page.offset)
        : Promise.resolve([]),
      this.db
        .select({ total: count() })
        .from(scimUsers)
        .innerJoin(users, eq(users.id, scimUsers.userId))
        .innerJoin(
          memberships,
          and(
            eq(memberships.tenantId, scimUsers.tenantId),
            eq(memberships.userId, scimUsers.userId),
          ),
        )
        .where(where),
    ]);
    return {
      schemas: [SCIM_SCHEMA.list],
      totalResults: total,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((row) => this.resource(row)),
    };
  }

  async get(id: string) {
    return this.resource(await this.find(this.db, id));
  }

  async create(actor: ClientPrincipal, input: ScimUserInput, ip?: string) {
    const tenantId = this.tenancy.tenantId();
    const email = await this.verifiedEmailOf(input);
    let deactivated = false;
    let ended: EndedCredentials | null = null;
    const userId = await this.unique(() =>
      inTransaction(this.txHost, async (tx) => {
        if (input.externalId) {
          await this.assertExternalIdFree(tx, input.externalId);
        }
        let account = await this.users.findByEmail(email, tx);
        let created = false;
        if (!account) {
          account = await this.users.create(tx, {
            email,
            name: displayNameOf(input, email),
            passwordHash: null,
            // The tenant proved it holds the domain (its DNS): its IdP's word counts.
            emailVerified: true,
          });
          created = true;
        } else {
          if (
            !(await this.users.lockAccount(tx, account.id)) &&
            // Deactivated by deprovisioning: provisioning brings it back.
            !(await this.users.isDeprovisioned(tx, account.id))
          ) {
            throw new ScimException(
              409,
              'The account with this address is deactivated.',
              'uniqueness',
            );
          }
          if (!account.emailVerified) {
            // Else whoever registered the address first, with a password
            // of their choosing, would become this tenant's member.
            throw new ScimException(
              409,
              'An account with this address exists and its address is unproved: it can’t be provisioned.',
              'uniqueness',
            );
          }
        }
        await this.users.lockMembership(tx, tenantId, account.id);
        const [linked] = await tx
          .select({ userId: scimUsers.userId })
          .from(scimUsers)
          .where(eq(scimUsers.userId, account.id));
        if (linked) {
          throw new ScimException(
            409,
            'This user is already provisioned.',
            'uniqueness',
          );
        }
        const member = await this.users.findMember(tenantId, account.id, tx);
        if (!member) {
          await this.users.addMembership(tx, tenantId, account.id);
        }
        await tx.insert(scimUsers).values({
          userId: account.id,
          externalId: input.externalId ?? null,
          attributes: attributesOf(input),
        });
        const wasActive = member ? member.active : true;
        const active = input.active ?? true;
        if (active !== wasActive) {
          await this.setActive(tx, actor, tenantId, account.id, active);
          deactivated = !active;
        }
        ended = await this.settleAccount(tx, actor, account.id, active, ip);
        await this.audit.record(
          actor,
          {
            action: 'scim.user-provisioned',
            targetType: 'user',
            targetId: account.id,
            details: {
              email,
              externalId: input.externalId ?? null,
              accountCreated: created,
              membershipCreated: !member,
              active,
            },
            ip,
          },
          tx,
        );
        return account.id;
      }),
    );
    await this.afterChange(userId, tenantId, deactivated, ended);
    return this.get(userId);
  }

  /** PUT: the IdP's whole representation replaces what was kept. */
  async replace(
    actor: ClientPrincipal,
    id: string,
    input: ScimUserInput,
    ip?: string,
  ) {
    const tenantId = this.tenancy.tenantId();
    let deactivated = false;
    let ended: EndedCredentials | null = null;
    await this.unique(() =>
      inTransaction(this.txHost, async (tx) => {
        // The account's lock first, as a creation takes it: never the
        // other way round (a deadlock).
        await this.users.lockAccount(tx, id);
        await this.users.lockMembership(tx, tenantId, id);
        const before = await this.find(tx, id);
        if (input.externalId && input.externalId !== before.externalId) {
          await this.assertExternalIdFree(tx, input.externalId);
        }
        await tx
          .update(scimUsers)
          .set({
            externalId: input.externalId ?? null,
            attributes: attributesOf(input),
            updatedAt: new Date(),
          })
          .where(eq(scimUsers.userId, id));
        const active = input.active ?? before.active;
        if (active !== before.active) {
          await this.setActive(tx, actor, tenantId, id, active);
          deactivated = !active;
          ended = await this.settleAccount(tx, actor, id, active, ip);
        }
        await this.audit.record(
          actor,
          {
            action: 'scim.user-updated',
            targetType: 'user',
            targetId: id,
            details: {
              email: before.email,
              ...(active !== before.active && {
                active: { from: before.active, to: active },
              }),
              ...((input.externalId ?? null) !== before.externalId && {
                externalId: {
                  from: before.externalId,
                  to: input.externalId ?? null,
                },
              }),
            },
            ip,
          },
          tx,
        );
      }),
    );
    await this.afterChange(id, tenantId, deactivated, ended);
    return this.get(id);
  }

  /**
   * PATCH (RFC 7644 §3.5.2): the operations applied by scim-patch to the
   * user as answered, the result checked as a PUT's body and written as one.
   */
  async patch(actor: ClientPrincipal, id: string, body: unknown, ip?: string) {
    const operations = patchOperations(body);
    const current = await this.get(id);
    let patched: Record<string, unknown>;
    try {
      patched = scimPatch(
        current as unknown as Parameters<typeof scimPatch>[0],
        operations,
        { mutateDocument: false, treatMissingAsAdd: true },
      ) as unknown as Record<string, unknown>;
    } catch (error) {
      throw patchError(error);
    }
    const parsed = scimUserSchema.safeParse(patched);
    if (!parsed.success) {
      throw new ScimException(
        400,
        `The patched user is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        'invalidValue',
      );
    }
    if (
      normalizeEmail(parsed.data.userName) !==
        normalizeEmail(String(current.userName)) &&
      !(await this.isVerifiedAddress(parsed.data.userName))
    ) {
      throw new ScimException(
        400,
        'The userName isn’t an address of a domain the tenant verified.',
        'invalidValue',
      );
    }
    return this.replace(actor, id, parsed.data, ip);
  }

  /**
   * DELETE: deprovisioned (the membership deactivated, as `active: false`),
   * and no longer the SCIM client's: a later POST of the same address
   * provisions it again.
   */
  async remove(actor: ClientPrincipal, id: string, ip?: string) {
    const tenantId = this.tenancy.tenantId();
    let deactivated = false;
    let ended: EndedCredentials | null = null;
    await inTransaction(this.txHost, async (tx) => {
      await this.users.lockAccount(tx, id);
      await this.users.lockMembership(tx, tenantId, id);
      const before = await this.find(tx, id);
      if (before.active) {
        await this.setActive(tx, actor, tenantId, id, false);
        deactivated = true;
      }
      ended = await this.settleAccount(tx, actor, id, false, ip);
      await tx.delete(scimUsers).where(eq(scimUsers.userId, id));
      await this.audit.record(
        actor,
        {
          action: 'scim.user-deprovisioned',
          targetType: 'user',
          targetId: id,
          details: { email: before.email, externalId: before.externalId },
          ip,
        },
        tx,
      );
    });
    await this.afterChange(id, tenantId, deactivated, ended);
  }

  /** Those of `ids` the SCIM client provisioned: a group's members can only be these. */
  async provisioned(tx: Transaction, ids: string[]) {
    if (!ids.length) {
      return [];
    }
    const rows = await tx
      .select({ id: scimUsers.userId })
      .from(scimUsers)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(inArray(scimUsers.userId, [...new Set(ids)]));
    const known = new Set(rows.map((row) => row.id));
    return ids.filter((id) => known.has(id));
  }

  /**
   * The membership turned on or off in the change's transaction, as an
   * administrator's deactivation (AccessAdminService.updateUser): at least
   * one administrator remains, and what waits on the person moves on.
   */
  private async setActive(
    tx: Transaction,
    actor: ClientPrincipal,
    tenantId: string,
    userId: string,
    active: boolean,
  ) {
    await this.users.setMembershipActive(tx, tenantId, userId, active);
    if (!active) {
      await this.accessAdmin.assertAnAdministratorRemains(tx);
      for (const listener of this.lifecycle.all()) {
        await listener.deactivated?.(tx, userId, actor);
      }
    }
  }

  /**
   * The account follows its memberships (the owner's decision, docs/auth.md,
   * "SCIM provisioning"): deactivated, never deleted, when deprovisioning
   * leaves it no active membership in any tenant (every session and token
   * family ends); reactivated, the same account with its data, when one is
   * active again. Audited in the change's transaction. What a deactivation
   * ended, for afterChange() once the transaction committed.
   */
  private async settleAccount(
    tx: Transaction,
    actor: ClientPrincipal,
    userId: string,
    active: boolean,
    ip?: string,
  ): Promise<EndedCredentials | null> {
    const ended = active
      ? null
      : await this.users.deactivateIfNoMembership(tx, userId);
    const changed = active
      ? await this.users.reactivateDeprovisioned(tx, userId)
      : ended !== null;
    if (changed) {
      await this.audit.record(
        actor,
        {
          action: active
            ? 'scim.account-reactivated'
            : 'scim.account-deactivated',
          targetType: 'user',
          targetId: userId,
          details: { reason: active ? 'membership' : 'no-active-membership' },
          ip,
        },
        tx,
      );
    }
    return ended;
  }

  /**
   * After the commit: a deactivation's sessions and tokens in this tenant
   * end, and those of an account it deactivated (`ended`) have their
   * sockets ended (a socket in no tenant is in no tenant's room).
   */
  private async afterChange(
    userId: string,
    tenantId: string,
    deactivated: boolean,
    ended: EndedCredentials | null = null,
  ) {
    await this.users.afterCredentialsEnded(ended);
    if (deactivated) {
      await this.users.endTenantSessions(userId, tenantId);
      for (const listener of this.lifecycle.all()) {
        await listener.afterDeactivation?.(userId, tenantId);
      }
    }
    this.access.invalidate();
  }

  private async verifiedEmailOf(input: ScimUserInput) {
    const candidates = [
      ...(input.emails ?? [])
        .slice()
        .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
        .map((email) => email.value),
      input.userName,
    ];
    const email = candidates.find(
      (value) => z.email().safeParse(value.trim()).success,
    );
    if (!email) {
      throw new ScimException(
        400,
        'The user needs an email address: in emails, or as its userName.',
        'invalidValue',
      );
    }
    if (!(await this.isVerifiedAddress(email))) {
      throw new ScimException(
        400,
        'The address isn’t in a domain the tenant verified (docs/auth.md, "Enterprise SSO").',
        'invalidValue',
      );
    }
    return normalizeEmail(email);
  }

  private async isVerifiedAddress(value: string) {
    return (
      z.email().safeParse(value.trim()).success &&
      this.domains.isVerified(emailDomain(normalizeEmail(value)))
    );
  }

  private async assertExternalIdFree(tx: Transaction, externalId: string) {
    const [taken] = await tx
      .select({ userId: scimUsers.userId })
      .from(scimUsers)
      .where(eq(scimUsers.externalId, externalId));
    if (taken) {
      throw new ScimException(
        409,
        'Another user has this externalId.',
        'uniqueness',
      );
    }
  }

  /** Two creations at once: the second's unique violation is the 409 the first check gives. */
  private async unique<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw new ScimException(
          409,
          'This user (or its externalId) is already provisioned.',
          'uniqueness',
        );
      }
      throw error;
    }
  }

  private userNameColumn() {
    // The userName the IdP sent, else the account's address.
    return sql`coalesce(${scimUsers.attributes}->>'userName', ${users.email})` as SQL;
  }

  private select(where?: SQL) {
    return this.db
      .select({
        userId: scimUsers.userId,
        externalId: scimUsers.externalId,
        attributes: scimUsers.attributes,
        createdAt: scimUsers.createdAt,
        updatedAt: scimUsers.updatedAt,
        email: users.email,
        active: memberships.active,
      })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(where);
  }

  private async find(
    db: ReturnType<typeof database> | Transaction,
    id: string,
  ): Promise<Row> {
    if (!z.uuid().safeParse(id).success) {
      throw new ScimException(404, `User ${id} not found.`);
    }
    const [row] = await db
      .select({
        userId: scimUsers.userId,
        externalId: scimUsers.externalId,
        attributes: scimUsers.attributes,
        createdAt: scimUsers.createdAt,
        updatedAt: scimUsers.updatedAt,
        email: users.email,
        active: memberships.active,
      })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(eq(scimUsers.userId, id));
    if (!row) {
      throw new ScimException(404, `User ${id} not found.`);
    }
    return row;
  }

  /** The SCIM User answered: what the IdP sent, with the server's own attributes. */
  private resource(row: Row) {
    const base = `${this.config.get('APP_URL', { infer: true })}`;
    return {
      ...row.attributes,
      schemas: [
        SCIM_SCHEMA.user,
        ...(row.attributes[SCIM_SCHEMA.enterpriseUser]
          ? [SCIM_SCHEMA.enterpriseUser]
          : []),
      ],
      id: row.userId,
      ...(row.externalId !== null && { externalId: row.externalId }),
      userName: (row.attributes.userName as string | undefined) ?? row.email,
      active: row.active,
      meta: {
        resourceType: 'User',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${base}/v1/scim/Users/${row.userId}`,
      },
    };
  }
}

const attributesOf = (input: ScimUserInput) =>
  Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => !NOT_STORED.has(key) && value !== undefined,
    ),
  );

const displayNameOf = (input: ScimUserInput, email: string) => {
  const name =
    input.displayName?.trim() ||
    input.name?.formatted?.trim() ||
    [input.name?.givenName, input.name?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
  return (name || email.split('@')[0]).slice(0, 200);
};

/** A PatchOp body's operations, checked by scim-patch. */
export function patchOperations(body: unknown): ScimPatchOperation[] {
  try {
    patchBodyValidation(body as ScimPatch);
  } catch (error) {
    throw patchError(error);
  }
  const operations = (body as ScimPatch).Operations;
  if (operations.length > 100) {
    throw new ScimException(400, 'At most 100 operations.', 'invalidValue');
  }
  return operations;
}

/** scim-patch's errors carry their `scimType`; anything else is a bad request. */
export function patchError(error: unknown) {
  const scimType = (error as { scimCode?: string }).scimCode;
  return new ScimException(
    400,
    (error as Error).message || 'The patch is invalid.',
    (scimType as ConstructorParameters<typeof ScimException>[2]) ??
      'invalidSyntax',
  );
}
