import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthenticationError,
  MfaService,
  PasswordHasher,
  type SessionRecord,
  SessionService,
  type TokenPair,
  TokenService,
} from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { eq, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { AuditService } from '../audit/audit.service.js';
import {
  authenticationOf,
  isRecent,
  tokenClaims,
} from '../auth/authentication-method.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import type { IamEnv } from '../iam.env.js';
import { sessions, userIdentities, users } from '../iam.tables.js';
import { oidcProviders } from './oidc.providers.js';

/** What a re-authentication in place presents (POST /auth/reauthenticate). */
export interface ReauthenticationProof {
  password?: string;
  code?: string;
  recoveryCode?: string;
  /** A token client's current refresh token: its family is revoked once the new tokens are issued. */
  refreshToken?: string;
}

/** How a user can re-authenticate, as the 403 and GET /auth/reauthenticate list it. */
export interface ReauthenticationOptions {
  /**
   * In place: `password`, `totp` (a code alone, for an account without a
   * password). By signing in again: `magic-link`, `oidc:<provider>`.
   * Passkeys (`passkey`) and SSO (`sso:<connection>`) add theirs.
   */
  methods: string[];
  /** In place, a code (or a recovery code) goes with the password: two-factor is on. */
  mfaRequired: boolean;
}

/**
 * Step-up: whether the request's credential was authenticated recently
 * enough for a sensitive route (`@RecentAuthentication()`), and proving it
 * again. A cookie session records when (`authenticatedAt` in its
 * metadata: the sign-in, then each re-authentication, which rotates the
 * session); an access token carries `auth_time`, fixed for its refresh
 * family, so a token client's re-authentication returns new tokens.
 *
 * An impersonation never counts: the person acting is not the account's
 * owner, and can't re-authenticate as them. API clients have no sign-in to
 * repeat: the check doesn't apply to them. Any other principal, or none,
 * is refused.
 *
 * Signing in again (magic link, a provider, SSO) is a re-authentication
 * too: every sign-in stamps its new session. A passkey (roadmap item 3)
 * plugs in as another proof here and another entry in `options()`.
 */
@Injectable()
export class ReauthenticationService {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly passwordHasher: PasswordHasher,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IamEnv, true>,
  ) {}

  /** How long an authentication counts as recent: `minutes`, or REAUTHENTICATION_MAX_AGE_MINUTES. */
  maxAgeMs(minutes?: number) {
    return (
      (minutes ??
        this.config.get('REAUTHENTICATION_MAX_AGE_MINUTES', { infer: true })) *
      60_000
    );
  }

  /**
   * The credential's authentication, and until when it counts as recent
   * (null: it doesn't, or never will: an impersonation).
   */
  status(session: unknown, maxAgeMinutes?: number) {
    const authentication = authenticationOf(session);
    const at = authentication?.authenticatedAt;
    return {
      authentication,
      recentUntil:
        at && authentication.method !== 'impersonation'
          ? new Date(at.getTime() + this.maxAgeMs(maxAgeMinutes))
          : null,
    };
  }

  /** Whether the request's credential was authenticated within the window. */
  isRecent(session: unknown, maxAgeMinutes?: number) {
    const { authentication, recentUntil } = this.status(session, maxAgeMinutes);
    return isRecent(authentication, recentUntil);
  }

  /** How `user` can re-authenticate: in place, or by signing in again. */
  async options(user: UserPrincipal): Promise<ReauthenticationOptions> {
    const [{ hasPassword, mfaOn }, identities] = await Promise.all([
      this.factors(user.id),
      this.db
        .select({ provider: userIdentities.provider })
        .from(userIdentities)
        .where(eq(userIdentities.userId, user.id)),
    ]);
    const configured = Object.keys(oidcProviders(this.config));
    const methods: string[] = [];
    if (hasPassword) {
      methods.push('password');
    } else if (mfaOn) {
      methods.push('totp');
    }
    // Magic links go to verified addresses only (MagicLinkMailer).
    if (
      this.config.get('AUTH_MAGIC_LINK', { infer: true }) &&
      user.emailVerified
    ) {
      methods.push('magic-link');
    }
    for (const { provider } of identities) {
      if (configured.includes(provider)) {
        methods.push(`oidc:${provider}`);
      }
    }
    return { methods, mfaRequired: mfaOn };
  }

  /**
   * Nothing, when the request's credential was authenticated within the
   * window; else a 403 `reauthentication_required` that says how to
   * re-authenticate, or a 403 while impersonating. Nobody signed in: 401.
   * An API client has no sign-in to repeat: not checked. A system principal
   * never reaches a route (PrincipalGuard), and would have nothing to prove
   * with: 403, as any other kind.
   */
  async assertRecent(
    user: Principal | null,
    session: unknown,
    maxAgeMinutes?: number,
  ) {
    if (!user) {
      throw new UnauthorizedException();
    }
    switch (user.kind) {
      case 'client':
        return;
      case 'user':
        break;
      default:
        throw new ForbiddenException();
    }
    if (user.impersonator) {
      throw new ForbiddenException(t('auth.notWhileImpersonating'));
    }
    const { authentication, recentUntil } = this.status(session, maxAgeMinutes);
    if (isRecent(authentication, recentUntil)) {
      return;
    }
    throw new ForbiddenException({
      code: 'reauthentication_required',
      message: t('auth.reauthenticationRequired'),
      maxAge: this.maxAgeMs(maxAgeMinutes) / 1000,
      authenticatedAt: authentication?.authenticatedAt?.toISOString() ?? null,
      ...(await this.options(user)),
    });
  }

  /**
   * Records that the user of session `sessionId` proved who they are at
   * `at`: when a sign-in's second factor completes (the package's
   * `completeMfa()` rotates the session and copies the first factor's
   * time, which may be minutes old by then). One atomic merge into the
   * session's metadata, so nothing else it holds is lost.
   */
  async stampAuthenticated(sessionId: string, at: Date) {
    await this.db
      .update(sessions)
      .set({
        metadata: sql`coalesce(${sessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ authenticatedAt: at.toISOString() })}::jsonb`,
      })
      .where(eq(sessions.id, sessionId));
  }

  /**
   * Proves again who the user is, with what the account signs in with: its
   * password, and a code when two-factor is on (a code alone for an account
   * without a password). A session gets a new id with `authenticatedAt`
   * now (`cookie`); a token client gets new tokens with `auth_time` now,
   * and the family of the `refreshToken` it sent, if any, is revoked.
   * Audited, failures too; a wrong code counts towards the lockout.
   */
  async reauthenticate(
    user: UserPrincipal,
    session: unknown,
    proof: ReauthenticationProof,
    ip: string,
  ): Promise<{
    authenticatedAt: Date;
    recentUntil: Date;
    cookie?: string;
    tokens?: TokenPair;
  }> {
    const fail = async (reason: string, error: HttpException) => {
      await this.audit.record(user, {
        action: 'auth.reauthentication-failed',
        targetType: 'user',
        targetId: user.id,
        details: { reason },
        ip,
      });
      return error;
    };
    if (user.impersonator) {
      throw await fail(
        'impersonating',
        new ForbiddenException(t('auth.notWhileImpersonating')),
      );
    }
    const authentication = authenticationOf(session);
    if (!authentication) {
      throw new UnauthorizedException();
    }
    const { passwordHash, mfaOn } = await this.factors(user.id);
    if (!passwordHash && !mfaOn) {
      throw new ConflictException({
        code: 'reauthentication_unavailable',
        message: t('auth.reauthenticationUnavailable'),
        ...(await this.options(user)),
      });
    }
    const missing = [
      ...(passwordHash && !proof.password ? ['password'] : []),
      ...(mfaOn && !proof.code && !proof.recoveryCode ? ['code'] : []),
    ];
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: t('auth.reauthenticationIncomplete'),
        errors: missing.map((path) => ({ path, message: t('auth.required') })),
      });
    }
    const refused = () =>
      new ForbiddenException({
        code: 'reauthentication_failed',
        message: t('auth.reauthenticationFailed'),
      });
    if (
      passwordHash &&
      !(await this.passwordHasher.verify(proof.password!, passwordHash))
    ) {
      throw await fail('password', refused());
    }
    const now = new Date();
    const secondFactor = mfaOn
      ? proof.recoveryCode
        ? { recoveryCode: proof.recoveryCode }
        : { code: proof.code }
      : undefined;
    let cookie: string | undefined;
    let tokens: TokenPair | undefined;
    if (authentication.via === 'token') {
      // The second factor is checked by issue(), once (a code works once).
      try {
        tokens = await this.tokens.issue(user.id, {
          method: passwordHash ? 'password' : 'totp',
          claims: tokenClaims(passwordHash ? ['pwd'] : [], now),
          secondFactor,
        });
      } catch (error) {
        if (error instanceof AuthenticationError) {
          throw await fail('code', refused());
        }
        throw error;
      }
      // The old family keeps its old time: it goes with the new one issued
      // (an unknown token revokes nothing, and says nothing: RFC 7009).
      if (proof.refreshToken) {
        await this.tokens.revoke(proof.refreshToken);
      }
    } else {
      if (secondFactor) {
        const verified = secondFactor.recoveryCode
          ? await this.mfa.verifyRecoveryCode(
              user.id,
              secondFactor.recoveryCode,
            )
          : await this.mfa.verifyTotp(user.id, secondFactor.code!);
        if (!verified) {
          throw await fail('code', refused());
        }
      }
      const record = session as SessionRecord;
      // A new id for the elevated session, as for any change of privilege.
      const issued = await this.sessions.rotate(record, {
        ...(mfaOn && { mfa: 'verified' as const }),
        metadata: { ...record.metadata, authenticatedAt: now.toISOString() },
      });
      if (!issued) {
        throw new UnauthorizedException(); // signed out meanwhile
      }
      cookie = issued.cookie;
    }
    await this.audit.record(user, {
      action: 'auth.reauthenticated',
      targetType: 'user',
      targetId: user.id,
      details: {
        method: passwordHash ? 'password' : 'totp',
        mfa: mfaOn,
        ...(secondFactor?.recoveryCode && { recoveryCode: true }),
        ...(authentication.via === 'token' && { via: 'token' }),
      },
      ip,
    });
    return {
      authenticatedAt: now,
      recentUntil: new Date(now.getTime() + this.maxAgeMs()),
      cookie,
      tokens,
    };
  }

  /** What the account signs in with: its password's hash, and whether two-factor is on. */
  async factors(userId: string) {
    const [[row], mfaOn] = await Promise.all([
      this.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId)),
      this.mfa.isEnrolled(userId),
    ]);
    const passwordHash = row?.passwordHash ?? null;
    return { passwordHash, hasPassword: passwordHash !== null, mfaOn };
  }
}
