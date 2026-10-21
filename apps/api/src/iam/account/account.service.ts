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
import { isSafeRedirectPath } from '../../core/http/redirect-path.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { and, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { isPlaceholderEmail } from '../auth/onboarding.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import { userIdentities, users } from '../iam.tables.js';
import {
  authenticationOf,
  methodMetadata,
  tokenClaims,
} from '../auth/authentication-method.js';
import { SsoPolicyService } from '../sso/sso-policy.service.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { BreachedPasswordsService } from './breached-passwords.service.js';
import { AuthPolicyService } from '../auth/auth-policy.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SignUpTenant } from '../access/sign-up-tenant.js';
import { CredentialsService } from './credentials.service.js';
import {
  ProviderReauthentications,
  ReauthenticationRefused,
  reauthenticationUrl,
} from './oidc-reauthentication.js';
import { PasswordHashLimiter } from './password-hashing.js';
import { ReauthenticationService } from './reauthentication.service.js';
import { SecurityAlertsService } from './security-alerts.service.js';
import { SignInLog } from './sign-in-log.service.js';
import { deviceLabel } from './devices.js';
import { assertNotLastSignInMethod } from './sign-in-methods.js';

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
    private readonly signInLog: SignInLog,
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
    private readonly providerReauthentications: ProviderReauthentications,
    private readonly tenancy: Tenancy,
    private readonly signUpTenant: SignUpTenant,
    private readonly authPolicy: AuthPolicyService,
    private readonly ssoPolicy: SsoPolicyService,
  ) {}

  /** A new account with a password (not one found in data breaches), audited. */
  async signUp(
    input: {
      email: string;
      name: string;
      password: string;
      locale: string | null;
      timezone: string | null;
      /** TENANT_SIGN_UP: the new tenant's name. */
      tenantName: string;
    },
    ip: string,
  ) {
    const { password, tenantName, ...fields } = input;
    // TENANCY=single: the tenant's minimum length (auth.passwordMinLength).
    await this.authPolicy.assertPasswordLength(password, 'password', {
      signUp: true,
    });
    await this.breachedPasswords.assertNotBreached(password, 'password');
    const passwordHash = await this.passwordHasher.hash(password);
    // In the same transaction: TENANCY=single, the account joins the tenant;
    // TENANT_SIGN_UP, it makes its own and administers it.
    return this.signUpTenant.newAccount(
      async (tx) => {
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
      },
      { tenantName, ip },
    );
  }

  /**
   * The first administrator's onboarding (docs/auth.md): the placeholder
   * address becomes `email`, unproved, and its verification link goes there.
   * Wants the current password, only while the onboarding asks for it. The
   * change and its audit entry are one transaction; the mail follows.
   */
  async changeOnboardingEmail(
    user: UserPrincipal,
    input: { email: string; currentPassword: string },
  ) {
    if (!user.onboarding?.email) {
      throw new ConflictException(t('auth.onboardingNotPending'));
    }
    const email = normalizeEmail(input.email);
    if (isPlaceholderEmail(email)) {
      throw new BadRequestException({
        code: 'placeholder_email',
        message: t('auth.placeholderEmail'),
        errors: [{ path: 'email', message: t('auth.placeholderEmail') }],
      });
    }
    const found = await this.users.findActiveByEmail(user.email);
    const valid = await this.passwordHasher.verify(
      input.currentPassword,
      found?.passwordHash ?? undefined,
    );
    if (!valid || !found?.passwordHash) {
      throw new ForbiddenException(t('auth.wrongPassword'));
    }
    if (email !== user.email && (await this.users.findActiveByEmail(email))) {
      throw new ConflictException(t('auth.emailTaken'));
    }
    await inTransaction(this.txHost, async (tx) => {
      await tx
        .update(users)
        .set({ email, emailVerified: false })
        .where(eq(users.id, user.id));
      await this.audit.record(
        user,
        {
          action: 'user.email-changed',
          targetType: 'user',
          targetId: user.id,
          details: { from: user.email, to: email, via: 'onboarding' },
        },
        tx,
      );
    });
    await this.emailVerification.send({ id: user.id, email });
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
    // The account's tenants' minimum length, read without spending the link.
    const userId = await this.users.pendingReset(token);
    if (userId) {
      await this.authPolicy.assertPasswordLength(password, 'password', {
        userId,
      });
    }
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
        // A reset link also replaces the generated password and proved the
        // address: the first administrator's onboarding is done as far as it can be.
        .set({
          emailVerified: true,
          onboardingPassword: false,
          ...(user &&
            !isPlaceholderEmail(user.email) && { onboardingEmail: false }),
        })
        .where(eq(users.id, userId));
      return this.securityAlerts.credentialsChanged(tx, user, userId, {
        action: 'auth.password-reset',
        ip,
        type: 'security.passwordChanged',
        data: { via: 'reset' },
        // An invitation's first password is no news to anyone.
        onlyIfUsed: true,
        settles: 'security.passwordBreached',
      });
    });
    if (told) {
      this.securityAlerts.deliverNow();
    }
    await this.securityAlerts.announceSettled(userId);
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
    // A tenant that lets a password in ("SSO required": 403 when none does).
    const tenantId = await this.ssoPolicy.signInTenant(
      user,
      'password',
      context.ip,
    );
    const issued = await this.signInService.signIn(user.id, {
      method: 'password',
      metadata: {
        ...methodMetadata('password'),
        ...(tenantId && { tenantId }),
      },
    });
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
        ? await this.ssoPolicy.signInTenant(user, 'password', context.ip)
        : (await this.users.isMember(user.id, tenantId))
          ? tenantId
          : null;
    if (tenantId !== undefined && !tenant) {
      await this.signInLog.tenantRefused(user, {
        method: 'password',
        ip: context.ip,
        tenantId,
      });
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    if (tenantId !== undefined && tenant) {
      // "SSO required": 403 when that tenant doesn't let a password in.
      await this.ssoPolicy.assertSignInTenant(
        user,
        tenant,
        'password',
        context.ip,
      );
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
      tenantId: tenant,
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
      // Checked again: a link stored before the rule, or by an older package, answers none.
      redirectTo: isSafeRedirectPath(issued.redirectTo)
        ? issued.redirectTo
        : undefined,
    };
  }

  /**
   * The OIDC callback: the package checks the state, exchanges the code,
   * resolves the account (OidcAccounts) and signs in, all inside `finish()`;
   * the context names the method for the session. Where to send the browser.
   *
   * A step-up's callback (its `state` was remembered by
   * `startReauthenticationWithProvider()`) runs as one: OidcAccounts
   * accepts only the user who started it, freshly authenticated, else
   * throws ReauthenticationRefused (no sign-in happens; the route sends the
   * browser back with an error). Audited either way, as the user's
   * `auth.reauthenticated` or `auth.reauthentication-failed`
   * (`method: oidc`), as a re-authentication in place is.
   *
   * The marker is read, and forgotten only once the callback was judged
   * (signed in, or refused): a request that fails the package's checks
   * (another client with a state it learnt, without this browser's
   * transaction cookie) leaves it in place. `stepUpExpected` (the browser
   * carries the step-up cookie for this state): without a marker, the
   * callback is refused (`expired`), never finished as a plain sign-in,
   * which would skip the same-user and freshness checks.
   */
  async signInWithProvider(
    provider: string,
    query: Record<string, string | undefined>,
    ip?: string,
    { stepUpExpected = false }: { stepUpExpected?: boolean } = {},
  ) {
    const reauthenticating = await this.providerReauthentications.peek(
      query.state,
    );
    const finish = () =>
      this.signInContext.run(
        `oidc:${provider}`,
        () => this.oidc.finish(provider, query),
        { reauthenticating },
      );
    if (!reauthenticating) {
      if (stepUpExpected) {
        await this.tenancy.none(() =>
          this.audit.record(null, {
            action: 'auth.reauthentication-failed',
            details: { method: 'oidc', provider, reason: 'expired' },
            ip,
          }),
        );
        throw new ReauthenticationRefused('expired');
      }
      return finish();
    }
    const user = await this.users.findActive(reauthenticating.userId);
    try {
      const redirect = await finish();
      await this.providerReauthentications.forget(query.state);
      // Account-level, as every sign-in's entry: in no tenant's log.
      await this.tenancy.none(() =>
        this.audit.record(user, {
          action: 'auth.reauthenticated',
          targetType: 'user',
          targetId: reauthenticating.userId,
          details: { method: 'oidc', provider },
          ip,
        }),
      );
      return redirect;
    } catch (error) {
      if (error instanceof ReauthenticationRefused) {
        await this.providerReauthentications.forget(query.state);
        await this.tenancy.none(() =>
          this.audit.record(user, {
            action: 'auth.reauthentication-failed',
            targetType: 'user',
            targetId: reauthenticating.userId,
            details: { method: 'oidc', provider, reason: error.reason },
            ip,
          }),
        );
      }
      throw error;
    }
  }

  /**
   * A step-up through a provider, for the signed-in `user`: the package's
   * login, its authorization URL asking the provider to authenticate the
   * user again (`prompt=login`, `max_age=0`: `reauthenticationUrl()`), and
   * the login's `state` remembered as a step-up of this user, from now.
   */
  async startReauthenticationWithProvider(
    user: UserPrincipal,
    provider: string,
    redirectTo: string | undefined,
  ) {
    const redirect = await this.oidc.start(provider, { redirectTo });
    const url = reauthenticationUrl(redirect.url);
    const state = url.searchParams.get('state');
    if (!state) {
      throw new Error(`OidcService.start(${provider}) answered no state`);
    }
    await this.providerReauthentications.remember(state, {
      userId: user.id,
      startedAt: Date.now(),
      tenantId: user.tenantId ?? null,
      ...(redirectTo !== undefined && { redirectTo }),
    });
    return { ...redirect, url: url.toString() };
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
    await this.authPolicy.assertPasswordLength(
      passwords.newPassword,
      'newPassword',
      { userId: user.id },
    );
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
        settles: 'security.passwordBreached',
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
    await this.securityAlerts.announceSettled(user.id);
  }

  /**
   * The user's browser sessions as the sessions list shows them, with a
   * readable `device` ("Chrome on macOS") from the recorded user agent.
   * While an administrator acts as the user: only that session (the
   * person's others, their devices and other tenants, are theirs).
   */
  async listSessions(user: UserPrincipal, current: SessionRecord | undefined) {
    const sessions = (await this.sessions.list(user.id)).filter(
      (session) => !user.impersonator || session.id === current?.id,
    );
    return sessions.map((session) => {
      const authentication = authenticationOf(session);
      const userAgent =
        (session.metadata?.userAgent as string | undefined) ?? null;
      return {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: session.lastActiveAt.toISOString(),
        userAgent,
        device: deviceLabel(userAgent),
        method: authentication?.method ?? null,
        provider: authentication?.provider ?? null,
        mfa: authentication?.mfa ?? false,
        authenticatedAt: authentication?.authenticatedAt?.toISOString() ?? null,
        current: session.id === current?.id,
      };
    });
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
   * no passkey, no other provider): 409 `last_sign_in_method`. The account
   * row is locked first (`assertNotLastSignInMethod`), so two removals at
   * once (a provider, a passkey) can't each see "one left" and remove both.
   */
  async unlinkIdentity(user: UserPrincipal, provider: string) {
    await inTransaction(this.txHost, async (tx) => {
      const [linked] = await tx
        .select({ provider: userIdentities.provider })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.userId, user.id),
            eq(userIdentities.provider, provider),
          ),
        );
      if (!linked) {
        throw new NotFoundException();
      }
      await assertNotLastSignInMethod(tx, user.id);
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
