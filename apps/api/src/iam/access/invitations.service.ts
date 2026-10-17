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
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
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
import { AuditService } from '../audit/audit.service.js';
import {
  actorOf,
  principalKey,
  type Principal,
  type UserPrincipal,
} from '../auth/principal.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { invitations, roles, userRoles } from '../iam.tables.js';
import { AccessService } from './access.service.js';
import { TeamsService } from './teams.service.js';

/** What an invitation grants once accepted. */
export interface InvitationInput {
  email: string;
  /** The name a new account starts with. */
  name?: string;
  roleIds: string[];
  roleExpiresAt?: Record<string, string>;
  teamIds?: string[];
}

/** `inv_<tenant id>_<secret>`: the tenant, so the invitation is read in its scope. */
const TOKEN =
  /^inv_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

const hashOf = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * Adding people to a tenant (docs/tenancy.md, "Invitations"): invite-only.
 * An administrator invites an address with the roles and teams its
 * membership will have; the address gets a link. Nothing about an account
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
    private readonly teams: TeamsService,
    private readonly mailQueue: MailQueue,
    private readonly passwordHasher: PasswordHasher,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  /**
   * An invitation to the current tenant, in `tx` (the caller's transaction,
   * with its audit entry): a pending one to the same address is replaced.
   * Returns the link's token; `send()` mails it after the commit.
   */
  async create(tx: Transaction, input: InvitationInput, inviter: Principal) {
    const tenantId = this.tenancy.tenantId('An invitation');
    const email = normalizeEmail(input.email);
    const token = `inv_${tenantId}_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(
      Date.now() +
        this.config.get('INVITATION_TTL_HOURS', { infer: true }) * 3_600_000,
    );
    await tx
      .delete(invitations)
      .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt)));
    const [invitation] = await tx
      .insert(invitations)
      .values({
        email,
        name: input.name ?? null,
        roleIds: [...new Set(input.roleIds)],
        roleExpiresAt: input.roleExpiresAt ?? {},
        teamIds: input.teamIds ?? [],
        tokenHash: hashOf(token),
        invitedBy: principalKey(inviter),
        expiresAt,
      })
      .returning();
    return { invitation: invitation!, token };
  }

  /** Mails the link (after the invitation's commit), in the inviter's language. */
  async send(
    invitation: { email: string; expiresAt: Date },
    token: string,
    inviter: Principal,
  ) {
    const tenant = await this.tenancy.find(this.tenancy.tenantId());
    await this.mailQueue.send(TenantInvitationMail, {
      to: { address: invitation.email },
      data: {
        inviter: actorOf(inviter).actorLabel,
        tenant: tenant!.name,
        url: `${webUrl(this.config)}/accept-invitation?token=${encodeURIComponent(token)}`,
        expiresAt: invitation.expiresAt,
      },
    });
  }

  /** The tenant's invitations not accepted yet, newest first (expired ones too, marked so). */
  async pending() {
    const rows = await this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        name: invitations.name,
        roleIds: invitations.roleIds,
        teamIds: invitations.teamIds,
        invitedBy: invitations.invitedBy,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(isNull(invitations.acceptedAt))
      .orderBy(desc(invitations.id));
    return rows.map((row) => ({
      ...row,
      expired: row.expiresAt.getTime() <= Date.now(),
    }));
  }

  /** Withdraws a pending invitation: its link stops working. */
  async revoke(actor: UserPrincipal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [gone] = await tx
        .delete(invitations)
        .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
        .returning({ id: invitations.id, email: invitations.email });
      if (!gone) {
        throw new NotFoundException(`Invitation ${id} not found.`);
      }
      await this.audit.record(
        actor,
        {
          action: 'invitation.revoked',
          targetType: 'invitation',
          targetId: id,
          details: { email: gone.email },
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
   * gets the invitation's roles and teams, in the invitation's tenant, in
   * one transaction under the membership's lock (a deactivation racing it
   * waits, or wins first and the acceptance reactivates by design: the
   * invitation is the tenant's newer word).
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
    if (!invitation) {
      throw invalid();
    }
    const account = await this.accounts.findByEmail(invitation.email);
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
          email: invitation.email,
          name: input.name ?? invitation.name ?? invitation.email,
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
        await this.accounts.markEmailVerified(user.id, invitation.email, tx);
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
   * The invitation's roles and teams, as they are now: a role or team
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
    const teams = await this.teams.existing(tx, invitation.teamIds);
    await this.teams.setUserTeams(tx, userId, teams);
  }
}

const invalid = () =>
  new BadRequestException({
    code: 'invitation_invalid',
    message: t('auth.invitationInvalid'),
  });
