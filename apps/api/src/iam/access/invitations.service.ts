import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { MailQueue } from '../../core/mail/mail-queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenantScope } from '../../core/tenancy/tenant-scope.js';
import { TenantInvitationMail } from '../account/account.mails.js';
import { BreachedPasswordsService } from '../account/breached-passwords.service.js';
import { AuthPolicyService } from '../auth/auth-policy.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  actorOf,
  principalKey,
  type Principal,
  type UserPrincipal,
} from '../auth/principal.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { invitations, memberships, roles, userRoles } from '../iam.tables.js';
import { AccessService } from './access.service.js';
import { OrganizationalUnitsService } from './organizational-units.service.js';

/** What an invitation grants once accepted. */
export interface InvitationInput {
  /** Needed to send; a prepared one may wait for it. */
  email?: string;
  /** The name a new account starts with. */
  name?: string;
  roleIds: string[];
  roleExpiresAt?: Record<string, string>;
  unitIds?: string[];
}

/** What an administrator changes of a pending invitation; `email: null` takes the address away. */
export interface InvitationChanges {
  email?: string | null;
  name?: string | null;
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  unitIds?: string[];
}

/** `inv_<tenant id>_<secret>`: the tenant, so the invitation is read in its scope. */
const TOKEN =
  /^inv_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

const hashOf = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * Adding people to a tenant (docs/tenancy.md, "Invitations"), the one
 * pending-member lifecycle (docs/identity.md, "Getting people in"). An
 * administrator invites an address (sent now) or prepares a member (sent
 * later) with the roles and units its membership will have; sending gives
 * the address a link. Nothing about an account
 * is read, changed or shown until its owner accepts, and the answer is the
 * same whether or not the address has an account: a new address chooses
 * its password with the link (which proves the mailbox), an existing
 * account accepts while signed in. Administrators never set or change
 * anyone's password: a tenant can't take over an account another tenant's
 * members use, nor learn which addresses have one.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly accounts: UsersRepository,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly units: OrganizationalUnitsService,
    private readonly mailQueue: MailQueue,
    private readonly passwordHasher: PasswordHasher,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly authPolicy: AuthPolicyService,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  /**
   * An invitation to the current tenant, in `tx` (the caller's transaction,
   * with its audit entry): a pending one to the same address is replaced.
   * `send`: with its link, whose token is returned (`send()` mails it after
   * the commit); otherwise prepared, with no link (token null).
   */
  async create(
    tx: Transaction,
    input: InvitationInput,
    inviter: Principal,
    send = true,
  ) {
    const tenantId = this.tenancy.tenantId('An invitation');
    const email = input.email ? normalizeEmail(input.email) : null;
    if (send && !email) {
      throw emailRequired();
    }
    const link = send ? this.newLink(tenantId) : null;
    if (email) {
      await this.replacePendingTo(tx, email);
    }
    const [invitation] = await tx
      .insert(invitations)
      .values({
        email,
        name: input.name ?? null,
        roleIds: [...new Set(input.roleIds)],
        roleExpiresAt: input.roleExpiresAt ?? {},
        unitIds: input.unitIds ?? [],
        invitedBy: principalKey(inviter),
        ...(link && {
          tokenHash: link.tokenHash,
          expiresAt: link.expiresAt,
          sentAt: new Date(),
        }),
      })
      .returning();
    return { invitation: invitation!, token: link?.token ?? null };
  }

  /** One pending invitation per address: the newest replaces the others. */
  private async replacePendingTo(
    tx: Transaction,
    email: string,
    keep?: string,
  ) {
    await tx
      .delete(invitations)
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          keep ? ne(invitations.id, keep) : undefined,
        ),
      );
  }

  /** A pending invitation, locked until `tx` ends (one change at a time), or null. */
  async lockPending(tx: Transaction, id: string) {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .for('update');
    return invitation ?? null;
  }

  /**
   * A pending invitation's changes (`current`, locked by `lockPending()`),
   * in `tx` (the caller's, with its audit entry). A new address withdraws
   * the link (it went to the old one): the invitation is prepared again
   * until sent.
   */
  async update(
    tx: Transaction,
    current: typeof invitations.$inferSelect,
    changes: InvitationChanges,
  ) {
    const email =
      changes.email === undefined
        ? current.email
        : changes.email && normalizeEmail(changes.email);
    const moved = email !== current.email;
    if (moved && email) {
      await this.replacePendingTo(tx, email, current.id);
    }
    const [invitation] = await tx
      .update(invitations)
      .set({
        email,
        ...(changes.name !== undefined && { name: changes.name }),
        ...(changes.roleIds && { roleIds: [...new Set(changes.roleIds)] }),
        ...(changes.roleExpiresAt && { roleExpiresAt: changes.roleExpiresAt }),
        ...(changes.unitIds && { unitIds: changes.unitIds }),
        ...(moved && { tokenHash: null, expiresAt: null, sentAt: null }),
      })
      .where(eq(invitations.id, current.id))
      .returning();
    return {
      invitation: invitation!,
      linkWithdrawn: moved && current.tokenHash !== null,
    };
  }

  /**
   * A pending invitation's new link and expiry, in `tx` (the caller's, with
   * its audit entry): a prepared one is sent, a sent one's old link stops
   * working. Null when it was accepted or withdrawn, or has no address
   * (any more). `send()` mails the token after the commit.
   */
  async renew(tx: Transaction, id: string) {
    const { token, tokenHash, expiresAt } = this.newLink(
      this.tenancy.tenantId('An invitation'),
    );
    const [invitation] = await tx
      .update(invitations)
      .set({ tokenHash, expiresAt, sentAt: new Date() })
      .where(
        and(
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          isNotNull(invitations.email),
        ),
      )
      .returning();
    return invitation ? { invitation, token } : null;
  }

  /** A link's token (`inv_<tenant>_<secret>`), its stored hash, and when it ends. */
  private newLink(tenantId: string) {
    const token = `inv_${tenantId}_${randomBytes(32).toString('base64url')}`;
    return {
      token,
      tokenHash: hashOf(token),
      expiresAt: new Date(
        Date.now() +
          this.config.get('INVITATION_TTL_HOURS', { infer: true }) * 3_600_000,
      ),
    };
  }

  /** Mails the link (after the invitation's commit), in the inviter's language. */
  async send(
    invitation: { email: string | null; expiresAt: Date | null },
    token: string,
    inviter: Principal,
  ) {
    const tenant = await this.tenancy.find(this.tenancy.tenantId());
    await this.mailQueue.send(TenantInvitationMail, {
      to: { address: invitation.email! },
      data: {
        inviter: actorOf(inviter).actorLabel,
        tenant: tenant!.name,
        url: `${webUrl(this.config)}/accept-invitation?token=${encodeURIComponent(token)}`,
        expiresAt: invitation.expiresAt!,
      },
    });
  }

  /**
   * The tenant's invitations not accepted yet, newest first, each with its
   * `status`: `prepared` (no link yet), `sent`, or `expired` (its link).
   */
  async pending() {
    const rows = await this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        name: invitations.name,
        roleIds: invitations.roleIds,
        roleExpiresAt: invitations.roleExpiresAt,
        unitIds: invitations.unitIds,
        invitedBy: invitations.invitedBy,
        sent: isNotNull(invitations.tokenHash),
        sentAt: invitations.sentAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(isNull(invitations.acceptedAt))
      .orderBy(desc(invitations.id));
    return rows.map(({ sent, ...row }) => ({
      ...row,
      status: invitationStatus(sent, row.expiresAt),
    }));
  }

  /** Withdraws a pending invitation: its link stops working. */
  async revoke(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [gone] = await tx
        .delete(invitations)
        .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
        .returning({
          id: invitations.id,
          email: invitations.email,
          roleIds: invitations.roleIds,
        });
      if (!gone) {
        throw new NotFoundException(`Invitation ${id} not found.`);
      }
      await this.audit.record(
        actor,
        {
          action: 'invitation.revoked',
          targetType: 'invitation',
          targetId: id,
          details: { email: gone.email, roleIds: gone.roleIds },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Accepts an invitation with its link's token. A new address makes its
   * account here (`password`, `name`), its address proved by the link; an
   * existing account must be the caller's (signed in as it). The membership
   * gets the invitation's roles and units, in the invitation's tenant, in
   * one transaction under the membership's lock (a deactivation racing it
   * waits, or wins first and the acceptance is refused: an acceptance never
   * turns a deactivated membership back on, an administrator does).
   */
  async accept(
    token: string,
    input: { password?: string; name?: string },
    caller: UserPrincipal | null,
    ip: string,
  ) {
    const tenantId = TOKEN.exec(token)?.[1];
    if (!tenantId) {
      throw invalid();
    }
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant?.active) {
      throw invalid();
    }
    return this.tenancy.run(tenantScope(tenantId), () =>
      this.acceptIn(tenantId, token, input, caller, ip),
    );
  }

  private async acceptIn(
    tenantId: string,
    token: string,
    input: { password?: string; name?: string },
    caller: UserPrincipal | null,
    ip: string,
  ) {
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, hashOf(token)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    // A prepared one has no token (nor address): nothing matches it.
    if (!invitation?.email) {
      throw invalid();
    }
    const email = invitation.email;
    const account = await this.accounts.findByEmail(email);
    if (account && !account.active) {
      throw invalid();
    }
    let passwordHash: string | undefined;
    if (!account) {
      if (!input.password) {
        // A new address: its owner chooses the password here.
        throw new BadRequestException({
          code: 'password_required',
          message: t('auth.required'),
          errors: [{ path: 'password', message: t('auth.required') }],
        });
      }
      // The joined tenant's minimum length (auth.passwordMinLength): the
      // new account's only tenant.
      await this.authPolicy.assertPasswordLength(input.password, 'password', {
        tenantIds: [tenantId],
      });
      await this.breachedPasswords.assertNotBreached(
        input.password,
        'password',
      );
      passwordHash = await this.passwordHasher.hash(input.password);
    } else {
      if (!caller) {
        throw new UnauthorizedException({
          code: 'sign_in_required',
          message: t('auth.invitationSignIn'),
        });
      }
      if (caller.id !== account.id) {
        throw new ForbiddenException({
          code: 'invitation_other_account',
          message: t('auth.invitationOtherAccount'),
        });
      }
      if (caller.impersonator) {
        throw new ForbiddenException(t('auth.notWhileImpersonating'));
      }
    }
    const userId = await inTransaction(this.txHost, async (tx) => {
      const user =
        account ??
        (await this.accounts.create(tx, {
          email,
          name: input.name ?? invitation.name ?? email,
          passwordHash: passwordHash!,
          // The link reached this mailbox: the address is proved.
          emailVerified: true,
        }));
      // Under the account's lock (its deletion can't slip in between) and
      // the membership's (a deactivation neither).
      if (!(await this.accounts.lockAccount(tx, user.id))) {
        throw invalid();
      }
      await this.accounts.lockMembership(tx, tenantId, user.id);
      const [membership] = await tx
        .select({ active: memberships.active })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, user.id),
          ),
        );
      if (membership && !membership.active) {
        throw new ForbiddenException({
          code: 'membership_inactive',
          message: t('auth.invitationMembershipInactive'),
        });
      }
      // Taken once: a second accept of the same link finds nothing.
      const [taken] = await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedBy: user.id })
        .where(
          and(
            eq(invitations.id, invitation.id),
            isNull(invitations.acceptedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (!taken) {
        throw invalid();
      }
      await this.accounts.joinTenant(tx, tenantId, user.id);
      if (account && !account.emailVerified) {
        await this.accounts.markEmailVerified(user.id, email, tx);
      }
      await this.grant(tx, user.id, invitation);
      const member = {
        ...(account ?? user),
        kind: 'user' as const,
        tenantId,
      };
      await this.audit.record(
        member,
        {
          action: 'user.joined',
          targetType: 'user',
          targetId: user.id,
          details: {
            invitation: invitation.id,
            invitedBy: invitation.invitedBy,
            roleIds: invitation.roleIds,
            ...(account ? {} : { accountCreated: true }),
          },
          ip,
        },
        tx,
      );
      return user.id;
    });
    this.access.invalidate();
    return { tenantId, userId, accountCreated: !account };
  }

  /**
   * The invitation's roles and units, as they are now: a role or unit
   * deleted since is left out (row-level security keeps it to the tenant).
   */
  private async grant(
    tx: Transaction,
    userId: string,
    invitation: typeof invitations.$inferSelect,
  ) {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    const existing = invitation.roleIds.length
      ? await tx
          .select({ id: roles.id })
          .from(roles)
          .where(inArray(roles.id, invitation.roleIds))
      : [];
    const now = Date.now();
    const grants = existing
      .map(({ id }) => {
        const end = invitation.roleExpiresAt[id];
        return { roleId: id, expiresAt: end ? new Date(end) : null };
      })
      .filter(({ expiresAt }) => !expiresAt || expiresAt.getTime() > now);
    if (grants.length) {
      await tx
        .insert(userRoles)
        .values(grants.map((grant) => ({ userId, ...grant })));
    }
    const units = await this.units.existing(tx, invitation.unitIds);
    await this.units.setUserUnits(tx, userId, units);
  }
}

/** A pending invitation's state, from its link: none yet, running, or ended. */
export const invitationStatus = (sent: boolean, expiresAt: Date | null) =>
  !sent
    ? ('prepared' as const)
    : expiresAt && expiresAt.getTime() > Date.now()
      ? ('sent' as const)
      : ('expired' as const);

const emailRequired = () =>
  new BadRequestException({
    code: 'email_required',
    message: t('auth.required'),
    errors: [{ path: 'email', message: t('auth.required') }],
  });

const invalid = () =>
  new BadRequestException({
    code: 'invitation_invalid',
    message: t('auth.invitationInvalid'),
  });
