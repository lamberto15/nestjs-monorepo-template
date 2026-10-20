import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Injectable, Logger } from '@nestjs/common';
import {
  AuthenticationRegistry,
  EmailVerificationHandler,
  type EmailVerificationLink,
  MagicLinkHandler,
  type MagicLink,
  type OAuthTokens,
  OidcAccountResolver,
  type OidcProfile,
  type OidcResolveContext,
  PasswordResetHandler,
  type PasswordResetLink,
} from '@nestjs/authentication';
import { MailQueue } from '../../core/mail/mail-queue.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/drizzle.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { authTimeOf, SignInContext } from '../auth/sign-in-context.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import { SignUpTenant } from '../access/sign-up-tenant.js';
import type { IamEnv } from '../iam.env.js';
import { userIdentities, users } from '../iam.tables.js';
import { oidcProviders } from './oidc.providers.js';
import {
  isFreshAuthentication,
  type ProviderReauthentication,
  ReauthenticationRefused,
} from './oidc-reauthentication.js';
import {
  InvitationMail,
  MagicLinkMail,
  ResetPasswordMail,
  VerifyEmailMail,
} from './account.mails.js';

/** The recipient of an account email: their stored address, name, language and time zone. */
async function recipient(db: Database, userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row;
}

/**
 * "Forgot your password?" and invitations: @nestjs/authentication creates
 * and checks the links (PasswordResetService); this sends them. An account
 * without a password gets the invitation email instead of the reset one.
 */
@Injectable()
export class PasswordResetMailer extends PasswordResetHandler {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly mailQueue: MailQueue,
    private readonly accounts: UsersRepository,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerHandler('passwordReset', this);
  }

  async findUser(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.active, true)));
    return row
      ? { id: row.id, email: row.email, passwordHash: row.passwordHash }
      : null;
  }

  async send(link: PasswordResetLink) {
    const user = await recipient(this.db, link.userId);
    if (!user) {
      return;
    }
    const options = {
      to: { name: user.name, address: link.email },
      data: {
        name: user.name,
        url: link.url,
        expiresAt: link.expiresAt,
        timezone: user.timezone,
      },
      locale: user.locale ?? undefined,
    };
    if (user.passwordHash) {
      await this.mailQueue.send(ResetPasswordMail, options);
    } else {
      await this.mailQueue.send(InvitationMail, options);
    }
  }

  async updatePassword(userId: string, passwordHash: string) {
    await this.accounts.updatePasswordHash(userId, passwordHash);
  }
}

/** Email verification links: sent here, recorded in `users.email_verified`. */
@Injectable()
export class EmailVerificationMailer extends EmailVerificationHandler {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly mailQueue: MailQueue,
    private readonly accounts: UsersRepository,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerHandler('emailVerification', this);
  }

  async send(link: EmailVerificationLink) {
    const user = await recipient(this.db, link.userId);
    if (!user) {
      return;
    }
    await this.mailQueue.send(VerifyEmailMail, {
      to: { name: user.name, address: link.email },
      data: {
        name: user.name,
        url: link.url,
        expiresAt: link.expiresAt,
        timezone: user.timezone,
      },
      locale: user.locale ?? undefined,
    });
  }

  markVerified(userId: string, email: string) {
    return this.accounts.markEmailVerified(userId, email);
  }

  isVerified(user: unknown) {
    return (user as UserPrincipal).emailVerified === true;
  }
}

/**
 * Passwordless sign-in links, for existing accounts only. Links to an
 * address nobody verified are refused: whoever registered it first must not
 * keep access once its owner signs in (account pre-hijacking).
 */
@Injectable()
export class MagicLinkMailer extends MagicLinkHandler {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly mailQueue: MailQueue,
    config: ConfigService<IamEnv, true>,
    registry: AuthenticationRegistry,
  ) {
    super();
    // The option and the handler go together (iam.module.ts reads the same flag).
    if (config.get('AUTH_MAGIC_LINK', { infer: true })) {
      registry.registerHandler('magicLink', this);
    }
  }

  async send(link: MagicLink) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(link.email)));
    if (!user) {
      return;
    }
    await this.mailQueue.send(MagicLinkMail, {
      to: { name: user.name, address: user.email },
      data: {
        name: user.name,
        url: link.url,
        expiresAt: link.expiresAt,
        timezone: user.timezone,
      },
      locale: user.locale ?? undefined,
    });
  }

  async resolveUser(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return row?.active && row.emailVerified
      ? { id: row.id, email: row.email }
      : null;
  }
}

/**
 * Sign in with Google, Microsoft or GitHub. An identity is found by
 * (provider, subject). A new one is linked:
 * - to the signed-in user who asked to connect it (`linkTo`);
 * - to the account with the same address, only when the provider verified
 *   the address and so did the account (never by an unverified email);
 * - to a new account, when sign-up is open (AUTH_SIGN_UP=on).
 * Anything else is refused.
 */
@Injectable()
export class OidcAccounts extends OidcAccountResolver {
  private readonly logger = new Logger('OAuth');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly accounts: UsersRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly signInContext: SignInContext,
    private readonly signUpTenant: SignUpTenant,
    registry: AuthenticationRegistry,
  ) {
    super();
    // The option and the resolver go together: only with a provider configured.
    if (Object.keys(oidcProviders(config)).length > 0) {
      registry.registerHandler('oidc', this);
    }
  }

  async resolveUser(
    profile: OidcProfile,
    _tokens: OAuthTokens,
    { linkTo }: OidcResolveContext,
  ) {
    const reauthenticating = linkTo
      ? undefined
      : this.signInContext.reauthenticating();
    if (reauthenticating) {
      return this.reauthenticated(profile, reauthenticating);
    }
    if (!linkTo) {
      this.recordAuthTime(profile);
    }
    const [known] = await this.db
      .select({ userId: userIdentities.userId, active: users.active })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(
        and(
          eq(userIdentities.provider, profile.provider),
          eq(userIdentities.subject, profile.subject),
        ),
      );
    if (known) {
      // Already someone's: connecting it to another account is refused.
      if (linkTo && linkTo.id !== known.userId) {
        return null;
      }
      return known.active ? { id: known.userId } : null;
    }
    if (linkTo) {
      return this.link(linkTo.id, profile);
    }
    if (!profile.email || !profile.emailVerified) {
      return null;
    }
    const existing = await this.accounts.findActiveByEmail(profile.email);
    if (existing) {
      return existing.user.emailVerified
        ? this.link(existing.user.id, profile)
        : null;
    }
    if (!this.config.get('AUTH_SIGN_UP', { infer: true })) {
      return null;
    }
    // In the same transaction: TENANCY=single, the account joins the tenant;
    // TENANT_SIGN_UP, it makes its own (named after the person) and administers it.
    const name = profile.name ?? profile.email!;
    const created = await this.signUpTenant.newAccount(
      async (tx) => {
        const account = await this.accounts.create(tx, {
          email: profile.email!,
          name,
          passwordHash: null,
          emailVerified: true,
        });
        await this.audit.record(
          account,
          {
            action: 'user.signed-up',
            targetType: 'user',
            targetId: account.id,
            details: { provider: profile.provider },
          },
          tx,
        );
        return account;
      },
      { tenantName: name },
    );
    this.logger.log('Account created from a provider', {
      userId: created.id,
      provider: profile.provider,
    });
    return this.link(created.id, profile);
  }

  /**
   * When the provider authenticated the user: the ID token's `auth_time`
   * (OpenID Connect), when it sends one. A provider may sign the user in
   * from its own session without asking again, so the sign-in here is no
   * proof of a recent one (step-up: ReauthenticationService); the claim
   * says when it was. Without it (GitHub: OAuth 2.0, no ID token; providers
   * that omit it), the sign-in counts as now, a weaker guarantee.
   */
  private recordAuthTime(profile: OidcProfile) {
    const at = authTimeOf(profile.claims);
    if (at) {
      this.signInContext.authenticatedAt(at);
    }
  }

  /**
   * A step-up through the provider (`?reauthenticate=true`): the identity
   * must be one already connected to the user who started it (never a new
   * account, a link by address, or someone else's), and the ID token's
   * `auth_time`, when it has one, after the step-up started: a provider
   * that ignored `prompt=login` and signed in from its own old session is
   * refused, not quietly accepted as a stale sign-in.
   */
  private async reauthenticated(
    profile: OidcProfile,
    expected: ProviderReauthentication,
  ) {
    const [known] = await this.db
      .select({ userId: userIdentities.userId, active: users.active })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(
        and(
          eq(userIdentities.provider, profile.provider),
          eq(userIdentities.subject, profile.subject),
        ),
      );
    if (!known?.active || known.userId !== expected.userId) {
      throw new ReauthenticationRefused('account', expected.redirectTo);
    }
    const authTime = authTimeOf(profile.claims);
    // An OpenID Connect provider issues an ID token, which must carry
    // auth_time here (max_age asked for it); plain OAuth 2.0 (GitHub) has none.
    const kind = oidcProviders(this.config)[profile.provider]?.kind ?? 'oidc';
    if (
      !isFreshAuthentication(authTime, expected.startedAt, {
        requireAuthTime: kind === 'oidc',
      })
    ) {
      throw new ReauthenticationRefused('stale', expected.redirectTo);
    }
    this.recordAuthTime(profile);
    // The new session acts where the re-authenticated one did, while the
    // membership is still active; else the last chosen tenant, as any
    // sign-in.
    if (
      expected.tenantId &&
      (await this.accounts.isMember(known.userId, expected.tenantId))
    ) {
      this.signInContext.keepTenant(expected.tenantId);
    }
    return { id: known.userId };
  }

  private async link(userId: string, profile: OidcProfile) {
    await this.db.insert(userIdentities).values({
      provider: profile.provider,
      subject: profile.subject,
      userId,
      email: profile.email ?? null,
    });
    await this.audit.record(null, {
      action: 'user.identity-linked',
      targetType: 'user',
      targetId: userId,
      details: { provider: profile.provider },
    });
    return { id: userId };
  }
}
