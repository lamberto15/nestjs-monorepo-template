import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  MagicLinkService,
  MfaService,
  OidcService,
  PasswordHasher,
  PasswordResetService,
  type SessionRecord,
  SessionService,
  SignInService,
  TokenService,
  EmailVerificationService,
} from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { and, count, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { userIdentities, users } from '../iam.tables.js';
import { signInOptions, tokenClaims } from '../auth/authentication-method.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { BreachedPasswordsService } from './breached-passwords.service.js';
import { CredentialsService } from './credentials.service.js';
import { PasswordHashLimiter } from './password-hashing.js';
import { ReauthenticationService } from './reauthentication.service.js';
import { SecurityAlertsService } from './security-alerts.service.js';

/** The fields a user may change on their own profile. */
export type ProfileChanges = {
  name?: string;
  locale?: string | null;
  timezone?: string | null;
};

/**
 * What people do to their own account: sign up, change their profile, finish
 * a password reset, and manage the providers they sign in with. Each change
 * is one transaction with its audit entry. (Administrators' changes to
 * others' accounts are AccessAdminService's.)
 */
@Injectable()
export class AccountService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly securityAlerts: SecurityAlertsService,
    private readonly credentials: CredentialsService,
    private readonly passwordHasher: PasswordHasher,
    private readonly signInService: SignInService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly magicLinks: MagicLinkService,
    private readonly passwordReset: PasswordResetService,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly signInContext: SignInContext,
    private readonly oidc: OidcService,
    private readonly reauthentication: ReauthenticationService,
    private readonly hashLimiter: PasswordHashLimiter,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  /** A new account with a password (not one found in data breaches), audited. */
  async signUp(
    input: {
      email: string;
      name: string;
      password: string;
      locale: string | null;
      timezone: string | null;
    },
    ip: string,
  ) {
    const { password, ...fields } = input;
    await this.breachedPasswords.assertNotBreached(password, 'password');
    const passwordHash = await this.passwordHasher.hash(password);
    return inTransaction(this.txHost, async (tx) => {
      const user = await this.users.create(tx, { ...fields, passwordHash });
      await this.audit.record(
        user,
        {
          action: 'user.signed-up',
          targetType: 'user',
          targetId: user.id,
          ip,
        },
        tx,
      );
      return user;
    });
  }

  updateProfile(userId: string, changes: ProfileChanges) {
    return this.users.update(this.db, userId, changes);
  }

  /**
   * Proves an address with its verification link. An account whose password
   * was chosen before its address was proved (a self sign-up) must also
   * give that password: the link alone proves the mailbox, not who chose
   * the password, and someone who signed up another person's address must
   * not have them verify it for him (docs/auth.md, "Sign-up"). Checked
   * before the package spends the link, so a missing or wrong password
   * leaves it usable; the mailbox's owner who didn't sign up resets the
   * password instead (its link proves the address and replaces it).
   */
  async verifyEmail(token: string, password: string | undefined) {
    const pending = await this.users.pendingVerification(token);
    if (pending?.passwordHash && !pending.emailVerified) {
      if (!password) {
        throw new BadRequestException({
          code: 'password_required',
          message: t('auth.required'),
          errors: [{ path: 'password', message: t('auth.required') }],
        });
      }
      const valid = await this.passwordHasher.verify(
        password,
        pending.passwordHash,
      );
      if (!valid) {
        throw new ForbiddenException(t('auth.wrongPassword'));
      }
    }
    const verified = await this.emailVerification.verify(token);
    if (!verified) {
      throw new BadRequestException(t('auth.invalidLink'));
    }
    return verified;
  }

  /**
   * A password set with a reset or invitation link (PasswordResetService):
   * refused before the link is spent when it's found in data breaches, then
   * a 400 for an unknown, used or expired link.
   *
   * The hashing slot is taken before the link: the package consumes the
   * token, then hashes the new password, so a 503 server_busy from a full
   * hashing queue there would spend the link (and a flood of sign-ins could
   * deny resets). Busy now, the link is untouched and the retry works.
   */
  async resetPassword(token: string, password: string, ip: string) {
    await this.breachedPasswords.assertNotBreached(password, 'password');
    const result = await this.hashLimiter.run(() =>
      this.passwordReset.reset(token, password),
    );
    if (!result) {
      throw new BadRequestException(t('auth.invalidLink'));
    }
    await this.passwordWasReset(result.userId, ip);
  }

  /** After a reset link set the password: the link went to the address and came back, so it's verified. */
  async passwordWasReset(userId: string, ip: string) {
    // Before the transaction: the actor as they are now, for the audit entry.
    const user = await this.users.findActive(userId);
    const told = await inTransaction(this.txHost, async (tx) => {
      await tx
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, userId));
      return this.securityAlerts.credentialsChanged(tx, user, userId, {
        action: 'auth.password-reset',
        ip,
        type: 'security.passwordChanged',
        data: { via: 'reset' },
        // An invitation's first password is no news to anyone.
        onlyIfUsed: true,
      });
    });
    if (told) {
      this.securityAlerts.deliverNow();
    }
  }

  /**
   * A sign-in with a password: the user, or a 401 (CredentialsService). The
   * session is the package's (its store commits by itself); the audit entry
   * and a new device's notification are one transaction (SecurityAlertsService).
   * With two-factor on, the alert goes already: the password was right.
   */
  async signInWithPassword(
    email: string,
    password: string,
    context: { ip: string; userAgent: string | undefined },
  ) {
    const user = await this.credentials.verify(email, password, context.ip);
    const issued = await this.signInService.signIn(
      user.id,
      signInOptions('password'),
    );
    await this.securityAlerts.signedIn(user, {
      ...context,
      method: 'password',
    });
    const mfaRequired = issued.session.mfa === 'pending';
    return { signedIn: !mfaRequired, mfaRequired };
  }

  /**
   * A token client's sign-in with a password (and its second factor when
   * two-factor is on): the user, or a 401; the tokens; the sign-in's audit
   * entry and a new device's notification, as for a browser.
   */
  async issueTokens(
    email: string,
    password: string,
    secondFactor: { code?: string; recoveryCode?: string },
    context: { ip: string; userAgent: string | undefined },
    tenantId?: string,
  ) {
    const user = await this.credentials.verify(email, password, context.ip);
    // The tenant asked for, when the user is a member (else the same 401 as
    // a wrong password: nothing about tenants is told before a sign-in);
    // else the last chosen (docs/tenancy.md).
    const tenant =
      tenantId === undefined
        ? await this.users.defaultTenant(user.id)
        : (await this.users.isMember(user.id, tenantId))
          ? tenantId
          : null;
    if (tenantId !== undefined && !tenant) {
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    const tokens = await this.tokens.issue(user.id, {
      method: 'password',
      // How, when and where, for every token of the family (step-up reads
      // auth_time, JwtAuth the tenant).
      claims: tokenClaims(['pwd'], new Date(), tenant),
      secondFactor,
    });
    await this.securityAlerts.signedIn(user, {
      ...context,
      method: 'password',
      via: 'token',
    });
    return tokens;
  }

  /**
   * A sign-in by email link, in the browser that asked for it (the
   * package's cookie): a 401 for a link unknown, used, expired or from
   * another browser; else the session, audited with the device as any
   * sign-in, and the user told of a new one.
   */
  async signInWithMagicLink(
    token: string,
    context: { ip: string; userAgent: string | undefined },
  ) {
    // The package signs in inside consume(): the context names the method.
    const issued = await this.signInContext.run('magic-link', () =>
      this.magicLinks.consume(token),
    );
    if (!issued) {
      throw new UnauthorizedException(t('auth.invalidLink'));
    }
    const user = await this.users.findActive(issued.session.userId);
    if (user) {
      await this.securityAlerts.signedIn(user, {
        ...context,
        method: 'magic-link',
      });
    }
    const mfaRequired = issued.session.mfa === 'pending';
    return {
      signedIn: !mfaRequired,
      mfaRequired,
      redirectTo: issued.redirectTo,
    };
  }

  /**
   * The OIDC callback: the package checks the state, exchanges the code,
   * resolves the account (OidcAccounts) and signs in, all inside `finish()`;
   * the context names the method for the session. Where to send the browser.
   */
  signInWithProvider(provider: string, query: Record<string, string>) {
    return this.signInContext.run(`oidc:${provider}`, () =>
      this.oidc.finish(provider, query),
    );
  }

  /**
   * The second step of a sign-in with two-factor on: the package verifies
   * the code and rotates the pending session to `verified`, copying its
   * metadata, the first factor's time included. The sign-in completes now,
   * so now is when the user proved who they are (step-up). `null`: no
   * pending session, or a wrong code.
   */
  async completeMfa(body: { code?: string; recoveryCode?: string }) {
    const issued = await this.signInService.completeMfa(body);
    if (issued) {
      await this.reauthentication.stampAuthenticated(
        issued.session.id,
        new Date(),
      );
    }
    return issued;
  }

  /**
   * A new password, checked against the current one (when the account has
   * one): the hash, its audit entry and the owner's notification in one
   * transaction. After the commit, every other session and every token
   * client is signed out (the package's stores, outside transactions) and
   * this browser's session gets a new id.
   */
  async changePassword(
    user: UserPrincipal,
    session: SessionRecord | undefined,
    passwords: { currentPassword?: string; newPassword: string },
    ip: string,
  ) {
    const found = await this.users.findActiveByEmail(user.email);
    if (found?.passwordHash) {
      const valid = await this.passwordHasher.verify(
        passwords.currentPassword ?? '',
        found.passwordHash,
      );
      if (!valid) {
        throw new ForbiddenException(t('auth.wrongPassword'));
      }
    }
    await this.breachedPasswords.assertNotBreached(
      passwords.newPassword,
      'newPassword',
    );
    const hash = await this.passwordHasher.hash(passwords.newPassword);
    const told = await inTransaction(this.txHost, async (tx) => {
      await this.users.updatePasswordHash(user.id, hash, tx);
      return this.securityAlerts.credentialsChanged(tx, user, user.id, {
        action: 'auth.password-changed',
        ip,
        type: 'security.passwordChanged',
        data: { via: 'change' },
      });
    });
    await this.sessions.revokeAll(user.id, { except: session?.id });
    await this.tokens.revokeAll(user.id);
    if (session) {
      await this.signInService.rotateSession();
    }
    if (told) {
      this.securityAlerts.deliverNow();
    }
  }

  /**
   * Two-factor on, with a first code from the app; returns the recovery
   * codes. The code's check commits by itself (see below); then the
   * recovery codes, the audit entry and the owner's notification are one
   * transaction (the store joins it through the transaction host).
   */
  async enableMfa(user: UserPrincipal, code: string, ip: string) {
    // Outside the transaction: a wrong code counts towards the lockout
    // (recorded by the package before the check) and then throws; a
    // rollback would forget the attempt.
    if (!(await this.signInService.confirmMfa(user.id, code))) {
      throw new BadRequestException(t('auth.invalidCode'));
    }
    let recoveryCodes: string[] = [];
    const told = await inTransaction(this.txHost, async (tx) => {
      recoveryCodes = await this.mfa.generateRecoveryCodes(user.id);
      return this.credentialsChanged(tx, user, true, ip);
    });
    if (told) {
      this.securityAlerts.deliverNow();
    }
    return recoveryCodes;
  }

  /**
   * Two-factor off, its audit entry and the owner's notification in one
   * transaction (the store joins it); then the tokens issued with the
   * second factor, which would keep claiming it, are revoked.
   */
  async disableMfa(user: UserPrincipal, ip: string) {
    const told = await inTransaction(this.txHost, async (tx) => {
      await this.mfa.disable(user.id);
      return this.credentialsChanged(tx, user, false, ip);
    });
    await this.tokens.revokeAll(user.id);
    if (told) {
      this.securityAlerts.deliverNow();
    }
  }

  /** In `tx`: the audit entry and the owner's notification of two-factor on or off. */
  private credentialsChanged(
    tx: Transaction,
    user: UserPrincipal,
    enabled: boolean,
    ip: string,
  ) {
    return this.securityAlerts.credentialsChanged(tx, user, user.id, {
      action: enabled ? 'auth.mfa-enabled' : 'auth.mfa-disabled',
      ip,
      type: 'security.mfaChanged',
      data: { enabled },
    });
  }

  /** The providers connected to the account. */
  async identities(userId: string) {
    const rows = await this.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId));
    return rows.map((row) => ({
      provider: row.provider,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Disconnects a provider, unless it's the last way to sign in (no password,
   * no other provider): 409. The account row is locked first, so two
   * disconnects at once can't each see "one left" and remove both.
   */
  async unlinkIdentity(user: UserPrincipal, provider: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [account] = await tx
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');
      const [{ identities }] = await tx
        .select({ identities: count() })
        .from(userIdentities)
        .where(eq(userIdentities.userId, user.id));
      if (!account?.passwordHash && identities <= 1) {
        throw new ConflictException(
          'This is your only way to sign in: set a password first.',
        );
      }
      const deleted = await tx
        .delete(userIdentities)
        .where(
          and(
            eq(userIdentities.userId, user.id),
            eq(userIdentities.provider, provider),
          ),
        )
        .returning();
      if (deleted.length === 0) {
        throw new NotFoundException();
      }
      await this.audit.record(
        user,
        {
          action: 'user.identity-unlinked',
          targetType: 'user',
          targetId: user.id,
          details: { provider },
        },
        tx,
      );
    });
  }
}
