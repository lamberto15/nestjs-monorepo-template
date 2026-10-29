import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthenticationError,
  MagicLinkService,
  OidcService,
  TokenService,
} from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { tokenClaims } from '../auth/authentication-method.js';
import { deviceLabel } from './devices.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { SsoPolicyService } from '../sso/sso-policy.service.js';
import {
  type NativeHandoff,
  NativeHandoffs,
  type NativeLogin,
} from './native-handoff.js';
import { nativeRedirect, verifiesChallenge } from './native-redirect.js';
import { SecurityAlertsService } from './security-alerts.service.js';
import { SignInLog } from './sign-in-log.service.js';

/**
 * Sign-ins that end in a native app (docs/auth.md, "Native and mobile
 * apps"): a provider's or a tenant's SSO login opened in the system
 * browser with an allow-listed `redirectUri` and a PKCE challenge, or a
 * magic link opened by the app, end with a one-time code instead of a
 * browser session; POST /auth/token/exchange turns it, with the verifier,
 * into tokens, with the same two-factor and tenant handling, audit,
 * sign-in log and new-device notification as POST /auth/token.
 *
 * Custom: @nestjs/authentication's provider and magic-link sign-ins end in
 * a session cookie; it has no token result for them (RFC 8252's flow).
 */
@Injectable()
export class NativeSignIn {
  constructor(
    private readonly handoffs: NativeHandoffs,
    private readonly tokens: TokenService,
    private readonly users: UsersRepository,
    private readonly ssoPolicy: SsoPolicyService,
    private readonly signInLog: SignInLog,
    private readonly securityAlerts: SecurityAlertsService,
    private readonly oidc: OidcService,
    private readonly magicLinks: MagicLinkService,
    private readonly signInContext: SignInContext,
    private readonly config: ConfigService<IamEnv, true>,
  ) {}

  /**
   * The native login a login route was asked for, checked before the flow
   * starts: undefined for a browser's (neither part), else both parts and
   * a `redirectUri` of NATIVE_REDIRECT_URIS, or 400.
   */
  nativeLogin({
    redirectUri,
    codeChallenge,
  }: {
    redirectUri?: string;
    codeChallenge?: string;
  }): NativeLogin | undefined {
    if (redirectUri === undefined && codeChallenge === undefined) {
      return undefined;
    }
    if (!redirectUri || !codeChallenge) {
      throw new BadRequestException(
        '`redirectUri` and `codeChallenge` go together.',
      );
    }
    if (
      !this.config
        .get('NATIVE_REDIRECT_URIS', { infer: true })
        .includes(redirectUri)
    ) {
      throw new BadRequestException({
        code: 'redirect_uri_not_allowed',
        message: 'This redirect URI is not one of NATIVE_REDIRECT_URIS.',
      });
    }
    return { redirectUri, codeChallenge };
  }

  /** Remembers a native login under its flow's key (an OIDC `state`, an SSO browser binding). */
  remember(key: string, login: NativeLogin) {
    return this.handoffs.startLogin(key, login);
  }

  /** The native login a callback's key names, if it is one. */
  login(key: unknown) {
    return this.handoffs.login(key);
  }

  /** Forgets it, once its callback was judged. */
  forget(key: unknown) {
    return this.handoffs.forgetLogin(key);
  }

  /**
   * A provider's callback for a native login: the package's checks and the
   * account's resolution, with no session (`signIn: false`); the URL that
   * hands the app its code. The login is forgotten once judged.
   */
  async finishProvider(
    provider: string,
    query: Record<string, string | undefined>,
    login: NativeLogin,
  ) {
    const method = `oidc:${provider}`;
    const { userId, authenticatedAt } = await this.signInContext.run(
      method,
      async () => {
        const finished = await this.oidc.finish(provider, query, {
          signIn: false,
        });
        return {
          userId: finished.userId,
          authenticatedAt: this.signInContext.toldAuthenticatedAt(),
        };
      },
    );
    await this.forget(query.state);
    if (!userId) {
      throw new Error(`OidcService.finish(${provider}) resolved no account`);
    }
    return this.handOff(login, { userId, method, authenticatedAt });
  }

  /** The URL that hands `login`'s app a code for this sign-in. */
  async handOff(
    login: NativeLogin,
    sign: Omit<NativeHandoff, 'codeChallenge' | 'authenticatedAt'> & {
      authenticatedAt?: Date | null;
    },
  ) {
    const { authenticatedAt, ...rest } = sign;
    const code = await this.handoffs.issueCode({
      ...rest,
      codeChallenge: login.codeChallenge,
      ...(authenticatedAt && { authenticatedAt: authenticatedAt.getTime() }),
    });
    return nativeRedirect(login.redirectUri, { code });
  }

  /** Where a native login that failed sends the app: its URI with `?error=`. */
  failed(login: NativeLogin, error: string) {
    return nativeRedirect(login.redirectUri, { error });
  }

  /**
   * A magic link opened by the app (the browser binding is the app's: it
   * kept the cookie of its request): spent, with no session, for a code
   * bound to `codeChallenge`. 401 for a link unknown, used, expired or
   * requested elsewhere.
   */
  async handOffMagicLink(token: string, codeChallenge: string) {
    const consumed = await this.signInContext.run('magic-link', () =>
      this.magicLinks.consume(token, { signIn: false }),
    );
    if (!consumed) {
      throw new UnauthorizedException(t('auth.invalidLink'));
    }
    const code = await this.handoffs.issueCode({
      userId: consumed.userId,
      method: 'magic-link',
      codeChallenge,
    });
    return { code };
  }

  /**
   * The tokens for a handoff code and its PKCE verifier (RFC 7636): 401
   * for a code unknown, used, expired or of another verifier (it is spent
   * either way). With two-factor on, a code from the app too: without
   * one, 401 `mfa_required` and the code stays for the retry (its time
   * left); a wrong one spends it. The tenant: the SSO connection's, else
   * `tenantId` (a member, else the token sign-in's 401), else the last
   * chosen; "SSO required" as for the password.
   */
  async exchange(
    input: {
      code: string;
      codeVerifier: string;
      tenantId?: string;
      secondFactor: { code?: string; recoveryCode?: string };
    },
    context: { ip: string; userAgent: string | undefined },
  ) {
    const taken = await this.handoffs.takeCode(input.code);
    if (
      !taken ||
      !verifiesChallenge(input.codeVerifier, taken.handoff.codeChallenge)
    ) {
      throw new UnauthorizedException(t('auth.invalidCode'));
    }
    const { handoff } = taken;
    const user = await this.users.findActive(handoff.userId);
    if (!user) {
      throw new UnauthorizedException(t('auth.invalidCode'));
    }
    const tenant = await this.tenantOf(user, handoff, input.tenantId, context);
    try {
      const tokens = await this.tokens.issue(user.id, {
        method: handoff.method,
        claims: tokenClaims(
          [],
          handoff.authenticatedAt
            ? new Date(handoff.authenticatedAt)
            : new Date(),
          tenant,
          { method: handoff.method, device: deviceLabel(context.userAgent) },
        ),
        secondFactor: input.secondFactor,
      });
      await this.securityAlerts.signedIn(user, {
        ...context,
        method: handoff.method,
        via: 'token',
        tenantId: tenant,
        ...(handoff.details && { details: handoff.details }),
      });
      return tokens;
    } catch (error) {
      if (
        error instanceof AuthenticationError &&
        error.code === 'mfa_required' &&
        !input.secondFactor.code &&
        !input.secondFactor.recoveryCode
      ) {
        await this.handoffs.restoreCode(input.code, handoff, taken.ttlMs);
      }
      throw error;
    }
  }

  private async tenantOf(
    user: UserPrincipal,
    handoff: NativeHandoff,
    tenantId: string | undefined,
    context: { ip: string },
  ) {
    const refuse = async (asked: string) => {
      await this.signInLog.tenantRefused(user, {
        method: handoff.method,
        ip: context.ip,
        tenantId: asked,
      });
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    };
    // A tenant's SSO connection signs in to that tenant only.
    if (handoff.tenantId) {
      if (tenantId !== undefined && tenantId !== handoff.tenantId) {
        return refuse(tenantId);
      }
      return handoff.tenantId;
    }
    if (tenantId === undefined) {
      return this.ssoPolicy.signInTenant(user, handoff.method, context.ip);
    }
    if (!(await this.users.isMember(user.id, tenantId))) {
      return refuse(tenantId);
    }
    await this.ssoPolicy.assertSignInTenant(
      user,
      tenantId,
      handoff.method,
      context.ip,
    );
    return tenantId;
  }
}
