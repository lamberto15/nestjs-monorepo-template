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
import type { CoreEnv } from '../../core/config/core.env.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  authenticationOf,
  tokenClaims,
} from '../auth/authentication-method.js';
import { deviceLabel } from './devices.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { UsersRepository } from '../auth/users.repository.js';
import type { IamEnv } from '../iam.env.js';
import { SsoPolicyService } from '../sso/sso-policy.service.js';
import {
  type NativeAccountFlow,
  type NativeHandoff,
  NativeHandoffs,
  type NativeLogin,
} from './native-handoff.js';
import { nativeRedirect, verifiesChallenge } from './native-redirect.js';
import {
  ReauthenticationRefused,
  reauthenticationUrl,
} from './oidc-reauthentication.js';
import { OidcAccounts } from './account.handlers.js';
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
 * A signed-in app links a provider, or steps up through one, the same way:
 * its token asks for a one-time ticket (`ticket()`) the system browser
 * opens, bound to the user, the token's session (`sid`), the purpose, the
 * redirect URI and the PKCE challenge; the callback's code works only for
 * that session (`complete()`), never as a sign-in.
 *
 * Custom: @nestjs/authentication's provider and magic-link sign-ins end in
 * a session cookie; it has no token result for them (RFC 8252's flow), and
 * its link flow needs a browser session, which a token-only app has not.
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
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
    private readonly oidcAccounts: OidcAccounts,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
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
    ip?: string,
  ) {
    const method = `oidc:${provider}`;
    const { account } = login;
    if (account && account.provider !== provider) {
      await this.forget(query.state);
      throw new BadRequestException("Another provider than the ticket's.");
    }
    const finish = () =>
      this.signInContext.run(
        method,
        async () => {
          const finished = await this.oidc.finish(provider, query, {
            signIn: false,
          });
          return {
            userId: finished.userId,
            authenticatedAt: this.signInContext.toldAuthenticatedAt(),
            identity: this.signInContext.toldIdentity(),
          };
        },
        account?.purpose === 'link'
          ? { linking: { id: account.userId } }
          : account
            ? {
                reauthenticating: {
                  userId: account.userId,
                  startedAt: account.startedAt,
                  tenantId: account.tenantId,
                },
              }
            : {},
      );
    let finished: Awaited<ReturnType<typeof finish>>;
    try {
      finished = await finish();
    } catch (error) {
      if (error instanceof ReauthenticationRefused) {
        await this.forget(query.state);
        await this.audited(
          account!,
          'auth.reauthentication-failed',
          { reason: error.reason },
          ip,
        );
      }
      throw error;
    }
    const { userId, authenticatedAt, identity } = finished;
    await this.forget(query.state);
    if (!userId) {
      throw new Error(`OidcService.finish(${provider}) resolved no account`);
    }
    if (account) {
      // The resolver links to, or re-authenticates, that user only.
      if (userId !== account.userId) {
        throw new Error('A native link or step-up resolved another account');
      }
      // A step-up's success is audited by complete(), once its second
      // factor checked out and its tokens exist.
    }
    return this.handOff(login, {
      userId,
      method,
      authenticatedAt,
      ...(account && {
        account: {
          purpose: account.purpose,
          sid: account.sid,
          provider: account.provider,
          tenantId: account.tenantId,
          ...(identity && { identity }),
        },
      }),
    });
  }

  /** A step-up's verdict, as the browser's (AccountService.signInWithProvider): account-level, in no tenant's log. */
  private async audited(
    account: { userId: string; provider: string },
    action: string,
    details: Record<string, unknown>,
    ip: string | undefined,
  ) {
    const user = await this.users.findActive(account.userId);
    await this.tenancy.none(() =>
      this.audit.record(user, {
        action,
        targetType: 'user',
        targetId: account.userId,
        details: {
          method: 'oidc',
          provider: account.provider,
          via: 'token',
          ...details,
        },
        ip,
      }),
    );
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

  /**
   * Where a native login that failed sends the app: its URI with `?error=`
   * (by default `sign_in_failed`, or a ticket's `link_failed` /
   * `reauthentication_failed`).
   */
  failed(login: NativeLogin, error?: string) {
    return nativeRedirect(login.redirectUri, {
      error:
        error ??
        (!login.account
          ? 'sign_in_failed'
          : login.account.purpose === 'link'
            ? 'link_failed'
            : 'reauthentication_failed'),
    });
  }

  /**
   * A ticket for a signed-in app to link `provider` or step up through it
   * (docs/auth.md, "Native and mobile apps"): token clients only (a browser
   * has `?link=true` and `?reauthenticate=true`), a token session with its
   * `sid`, and an allow-listed `redirectUri`. The URL its system browser
   * opens: the login route with the ticket, which starts the provider's
   * login there (its transaction cookie is the browser's).
   */
  async ticket(
    user: UserPrincipal,
    session: unknown,
    provider: string,
    body: {
      purpose: NativeAccountFlow['purpose'];
      redirectUri: string;
      codeChallenge: string;
    },
  ) {
    const sid = tokenSessionOf(session);
    if (!sid) {
      throw new BadRequestException({
        code: 'token_session_required',
        message:
          'For an app signed in with tokens: a browser links and steps up with `?link=true` and `?reauthenticate=true`.',
      });
    }
    const login = this.nativeLogin(body)!;
    const ticket = await this.handoffs.issueTicket({
      ...login,
      account: {
        purpose: body.purpose,
        userId: user.id,
        sid,
        provider,
        startedAt: Date.now(),
        tenantId: user.tenantId ?? null,
      },
    });
    const url = new URL(
      `/v1/auth/oidc/${encodeURIComponent(provider)}/login`,
      this.config.get('APP_URL', { infer: true }),
    );
    url.searchParams.set('ticket', ticket);
    return { url: url.toString() };
  }

  /**
   * The login route opened with a ticket: spent, and the provider's login
   * started in this browser, remembered as the ticket's link or step-up.
   * Both ask the provider to authenticate the user again: a link ticket
   * sent to someone else must not connect their identity in one silent
   * click (their provider session), whoever then catches the redirect. 400
   * for a ticket unknown, used, expired or of another provider.
   */
  async startTicket(provider: string, ticket: string) {
    const login = await this.handoffs.takeTicket(ticket);
    if (!login || login.account.provider !== provider) {
      throw new BadRequestException({
        code: 'invalid_ticket',
        message: 'This ticket is unknown, used or expired: ask for another.',
      });
    }
    const redirect = await this.oidc.start(provider, {});
    const url = reauthenticationUrl(redirect.url);
    // From now: the provider's `auth_time` must not be older than the login.
    await this.remember(url.searchParams.get('state')!, {
      ...login,
      account: { ...login.account, startedAt: Date.now() },
    });
    return { ...redirect, url: url.toString() };
  }

  /**
   * The code of a ticket's callback, with its verifier, for the signed-in
   * app that asked for the ticket: the same user and token session, else
   * 401 (the code is spent either way). A link answers its provider; a
   * step-up new tokens with `auth_time` now (the provider's, when it told),
   * in the same tenant and device, with two-factor as for the exchange
   * (without a code, 401 `mfa_required` and the code still works); the
   * family of the `refreshToken` sent, if any, is revoked.
   */
  async complete(
    user: UserPrincipal,
    session: unknown,
    input: {
      code: string;
      codeVerifier: string;
      refreshToken?: string;
      secondFactor: { code?: string; recoveryCode?: string };
    },
    ip?: string,
  ) {
    const taken = await this.handoffs.takeCode(input.code);
    const sid = tokenSessionOf(session);
    if (
      !taken?.handoff.account ||
      !verifiesChallenge(input.codeVerifier, taken.handoff.codeChallenge) ||
      taken.handoff.userId !== user.id ||
      !sid ||
      taken.handoff.account.sid !== sid
    ) {
      throw new UnauthorizedException(t('auth.invalidCode'));
    }
    const { handoff } = taken;
    const { account } = handoff;
    if (account!.purpose === 'link') {
      // Only now, by the app that holds the verifier and the session.
      if (account!.identity) {
        await this.oidcAccounts.linkNative(user.id, account!.identity);
      }
      return { purpose: 'link' as const, provider: account!.provider };
    }
    try {
      const tokens = await this.tokens.issue(user.id, {
        method: handoff.method,
        claims: tokenClaims(
          [],
          handoff.authenticatedAt
            ? new Date(handoff.authenticatedAt)
            : new Date(),
          account!.tenantId,
          { method: handoff.method, device: deviceOfClaims(session) },
        ),
        secondFactor: input.secondFactor,
      });
      // The old family keeps its old time: it goes with the new one issued.
      if (input.refreshToken) {
        await this.tokens.revoke(input.refreshToken);
      }
      await this.audited(
        { userId: user.id, provider: account!.provider },
        'auth.reauthenticated',
        {},
        ip,
      );
      return { purpose: 'reauthenticate' as const, ...tokens };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        if (!input.secondFactor.code && !input.secondFactor.recoveryCode) {
          // Only asked for: the code stays for the retry.
          if (error.code === 'mfa_required') {
            await this.handoffs.restoreCode(input.code, handoff, taken.ttlMs);
          }
        } else {
          // A wrong second factor, as the browser's step-up records it.
          await this.audited(
            { userId: user.id, provider: account!.provider },
            'auth.reauthentication-failed',
            { reason: 'code' },
            ip,
          );
        }
      }
      throw error;
    }
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
      // A link's or a step-up's code completes its session only, never signs in.
      taken.handoff.account ||
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

/** The `sid` of a token client's session (its access token's claims), if it is one. */
function tokenSessionOf(session: unknown) {
  if (authenticationOf(session)?.via !== 'token') {
    return undefined;
  }
  const sid = (session as { sid?: unknown }).sid;
  return typeof sid === 'string' && sid ? sid : undefined;
}

/** The `dev` claim of a token client's claims (tokenClaims()), if any. */
function deviceOfClaims(session: unknown) {
  const device = (session as { dev?: unknown } | undefined)?.dev;
  return typeof device === 'string' ? device : undefined;
}
