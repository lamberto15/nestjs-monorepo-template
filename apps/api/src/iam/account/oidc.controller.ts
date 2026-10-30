import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Delete,
  Ip,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import {
  Authenticate,
  CurrentSession,
  CurrentUser,
  OidcService,
  Public,
} from '@nestjs/authentication';
import { SessionAuth } from '../auth/session-auth.provider.js';
import { Can } from '@nestjs/authorization';
import { ConfigService } from '@nestjs/config';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import type { IamEnv } from '../iam.env.js';
import { oidcProviders } from './oidc.providers.js';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { listSchema } from '../../core/http/pagination.js';
import { redirectPath, webAppUrl } from '../../core/http/redirect-path.js';
import { AccountService } from './account.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { notWhileImpersonating, verifiedEmailOnly } from './account.schemas.js';
import {
  ReauthenticationRefused,
  reauthenticationCookie,
} from './oidc-reauthentication.js';
import { ReauthenticationService } from './reauthentication.service.js';
import { NativeSignIn } from './native-sign-in.service.js';
import {
  codeChallenge,
  codeVerifier,
  nativeLoginQuery,
} from './native-redirect.js';

const identitySchema = z.object({
  provider: z.string(),
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * The login route's query. A query parameter sent twice
 * (`?redirectTo=/a&redirectTo=//evil`) reaches the handler as an array, and
 * a string method on it throws (a 500, CodeQL
 * js/type-confusion-through-parameter-tampering): the schema makes each one a
 * string or, when it isn't one, absent (`catch`), since the browser is
 * navigating here and a problem response would be its landing page. So is
 * a `redirectTo` that isn't a path of the web app (`isSafeRedirectPath`):
 * dropped, never stored with the login, and the browser lands on the web
 * app's root.
 */
const loginQuerySchema = z.object({
  redirectTo: redirectPath
    .optional()
    .catch(undefined)
    .describe(
      'A path of the web app to land on (one leading `/`, printable ASCII, no `\\`); anything else is ignored.',
    ),
  link: z
    .string()
    .optional()
    .catch(undefined)
    .describe('`true`: connect the provider to the signed-in account.'),
  reauthenticate: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      '`true`: re-authenticate the signed-in user through the provider (step-up), with a fresh login there.',
    ),
  ...nativeLoginQuery,
  ticket: z
    .string()
    .max(128)
    .optional()
    .catch(undefined)
    .describe(
      "A signed-in app's link or step-up: the `url` of POST /auth/identities/{provider}/native carries it.",
    ),
});

const nativeTicketSchema = z.object({
  purpose: z
    .enum(['link', 'reauthenticate'])
    .describe(
      "`link`: connect the provider to your account (wants a recent sign-in, as the browser's). `reauthenticate`: step up through a provider already connected.",
    ),
  redirectUri: z
    .string()
    .max(2048)
    .describe(
      'One of NATIVE_REDIRECT_URIS: where the browser hands back `?code=` or `?error=`.',
    ),
  codeChallenge,
});

const nativeCompleteSchema = z.object({
  handoffCode: z
    .string()
    .min(1)
    .max(128)
    .describe("The `code` the ticket's `redirectUri` was handed."),
  codeVerifier: codeVerifier.describe(
    "The PKCE verifier of the ticket's `codeChallenge`.",
  ),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('A step-up with two-factor on: a code from the app.'),
  recoveryCode: z.string().max(64).optional(),
  refreshToken: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'A step-up: your current refresh token, revoked once the new pair is issued.',
    ),
});

const nativeCompletedSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('link'), identity: identitySchema }),
  z.object({
    purpose: z.literal('reauthenticate'),
    accessToken: z
      .string()
      .describe('A JWT with `auth_time` now: `Authorization: Bearer …`.'),
    refreshToken: z.string().describe('Single use: POST /auth/token/refresh.'),
    expiresIn: z
      .number()
      .int()
      .describe('Seconds until the access token expires.'),
  }),
]);

/**
 * What the provider sends back, and all that `OidcService.finish` reads
 * (`state`; `code`, `error` and `iss` in its client): each a string, so a
 * repeated parameter is a 400, not a 500. Anything else is dropped.
 */
const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  iss: z.string().optional(),
});

/**
 * Sign in with Google, Microsoft or GitHub (OidcService: PKCE, nonce, state
 * bound to the browser). The browser navigates to `login`; the provider sends
 * it back to `callback`, which signs it in and redirects to the web app.
 * `?link=true` from a signed-in session connects the provider to the account.
 */
@ApiTags('auth')
@Controller('auth')
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
    private readonly account: AccountService,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
    private readonly reauthentication: ReauthenticationService,
    private readonly native: NativeSignIn,
  ) {}

  /** 404 for a provider without credentials (and when none is configured at all). */
  private configured(provider: string) {
    if (!Object.hasOwn(oidcProviders(this.config), provider)) {
      throw new NotFoundException(`No provider named "${provider}".`);
    }
  }

  // Optional session: a link flow (?link=true) needs one (401), and not an
  // impersonation (403), and a recent sign-in: a provider linked by a stolen
  // session would let its thief back in at will. The browser navigates
  // here, so a stale sign-in is sent back to the web app with
  // `?error=reauthentication_required` instead of the guard's 403 problem,
  // which a navigation can't read; the web app asks GET /auth/reauthenticate
  // first to spare the round trip.
  @Authenticate({ optional: true, providers: [SessionAuth] })
  @Can.Anyone()
  @Get('oidc/:provider/login')
  @AllowInMaintenance()
  @Redirect()
  @ApiOperation({
    summary: 'Start signing in with a provider (navigate the browser here)',
    description:
      'With `link=true`, a signed-in session that is not recent (REAUTHENTICATION_MAX_AGE_MINUTES) is redirected to the web app (`redirectTo`, else its root) with `?error=reauthentication_required`: check GET /auth/reauthenticate first. With `reauthenticate=true`, a signed-in user steps up through the provider: it is asked to authenticate them again (`prompt=login`, `max_age=0`), and the callback accepts only that user, authenticated at the provider after the start (`auth_time`, when the ID token has one); otherwise the browser lands on the web app with `?error=reauthentication_failed`, signed in as before.',
  })
  @ApiFoundResponse({
    description:
      'To the provider; or, linking from a stale session, to the web app with `?error=reauthentication_required`.',
  })
  async login(
    @CurrentUser() user: UserPrincipal | null,
    @CurrentSession() session: unknown,
    @Param('provider') provider: string,
    @Query({ schema: loginQuerySchema })
    {
      redirectTo,
      link,
      reauthenticate,
      redirectUri,
      codeChallenge,
      ticket,
    }: z.infer<typeof loginQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (ticket !== undefined) {
      // A signed-in app's link or step-up: the ticket says whose, and how.
      this.configured(provider);
      return this.native.startTicket(provider, ticket);
    }
    const native = this.native.nativeLogin({ redirectUri, codeChallenge });
    if (native) {
      // A native app's sign-in (no session here: its code, then tokens).
      if (link === 'true' || reauthenticate === 'true') {
        throw new BadRequestException(
          'A native sign-in neither links nor re-authenticates.',
        );
      }
      this.configured(provider);
      const redirect = await this.oidc.start(provider, {});
      await this.native.remember(
        new URL(redirect.url).searchParams.get('state')!,
        native,
      );
      return redirect;
    }
    if (reauthenticate === 'true') {
      if (link === 'true') {
        throw new BadRequestException(
          '`link` and `reauthenticate` are two flows: one at a time.',
        );
      }
      if (!user) {
        throw new UnauthorizedException();
      }
      notWhileImpersonating(user);
      // As linking: an address the person proved (an invitation, the link).
      verifiedEmailOnly(user);
      this.configured(provider);
      const redirect = await this.account.startReauthenticationWithProvider(
        user,
        provider,
        redirectTo,
      );
      // This browser started a step-up for this state: its callback is one.
      res.append(
        'Set-Cookie',
        this.stepUpCookie().set(
          new URL(redirect.url).searchParams.get('state')!,
        ),
      );
      return redirect;
    }
    if (link === 'true') {
      if (!user) {
        throw new UnauthorizedException();
      }
      notWhileImpersonating(user);
      verifiedEmailOnly(user);
      if (!this.reauthentication.isRecent(session)) {
        return {
          url: this.backToWebApp(redirectTo, 'reauthentication_required'),
        };
      }
    }
    this.configured(provider);
    return this.oidc.start(provider, { redirectTo, link: link === 'true' });
  }

  /**
   * `redirectTo` (a path of the web app, else its root: `webAppUrl`, the
   * one rule for every redirect target) with `?error=`.
   */
  private backToWebApp(redirectTo: string | undefined, error: string) {
    const url = this.webApp(redirectTo);
    url.searchParams.set('error', error);
    return url.toString();
  }

  /** `value` on the web app (WEB_URL, else APP_URL, which has a default), else its root. */
  private webApp(value: unknown) {
    return webAppUrl(value, `${webUrl(this.config)}`);
  }

  @Public()
  @Get('oidc/:provider/callback')
  @AllowInMaintenance()
  @Redirect()
  @ApiOperation({ summary: 'Where the provider sends the browser back' })
  @ApiFoundResponse({
    description:
      'To the web app; a refused step-up (`reauthenticate=true`) with `?error=reauthentication_failed`. A native login: to its `redirectUri` with `?code=`, or `?error=sign_in_failed`.',
  })
  async callback(
    @Param('provider') provider: string,
    @Query({ schema: callbackQuerySchema })
    query: z.infer<typeof callbackQuerySchema>,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.configured(provider);
    const native = await this.native.login(query.state);
    if (native) {
      try {
        return {
          url: await this.native.finishProvider(provider, query, native, ip),
        };
      } catch (error) {
        // The app's browser lands back in the app, never on a problem page.
        if (
          error instanceof HttpException ||
          error instanceof ReauthenticationRefused
        ) {
          return { url: this.native.failed(native) };
        }
        throw error;
      }
    }
    const cookie = this.stepUpCookie();
    const stepUpExpected =
      query.state !== undefined &&
      cookie.read(req.headers.cookie) === query.state;
    try {
      const redirect = await this.account.signInWithProvider(
        provider,
        query,
        ip,
        { stepUpExpected },
      );
      if (stepUpExpected) {
        res.append('Set-Cookie', cookie.clear());
      }
      // The login's `redirectTo` (a path, else the package's
      // `redirectAfterLogin`) checked again and made the web app's: a login
      // stored before the rule lands on its root, and a path lands on the
      // web app, not on this API's origin.
      return {
        ...redirect,
        url: this.webApp(redirect.url).toString(),
      };
    } catch (error) {
      if (error instanceof ReauthenticationRefused) {
        res.append('Set-Cookie', cookie.clear());
        return {
          url: this.backToWebApp(error.redirectTo, 'reauthentication_failed'),
        };
      }
      throw error;
    }
  }

  /** The step-up cookie, Secure (and `__Host-`) as the session's (SESSION_COOKIE_SECURE). */
  private stepUpCookie() {
    return reauthenticationCookie(
      this.config.get('SESSION_COOKIE_SECURE', { infer: true }),
    );
  }

  @UserOnly()
  @Can.Anyone()
  @Get('identities')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({ summary: 'The providers connected to your account' })
  @ApiOkResponse({ standardSchema: listSchema(identitySchema) })
  async identities(@CurrentUser() user: UserPrincipal) {
    return { items: await this.account.identities(user.id) };
  }

  // A browser session has `?link=true`; a token-only app asks for a ticket.
  // Linking wants a recent sign-in, as the browser's link does.
  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication({
    when: (request) =>
      (request as { body?: { purpose?: unknown } }).body?.purpose === 'link',
  })
  @Post('identities/:provider/native')
  @HttpCode(201)
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({
    summary: 'Link a provider, or step up through one, from a native app',
    description:
      'For an app signed in with tokens (a browser session: 400 `token_session_required`; use `?link=true` / `?reauthenticate=true`). Answers the `url` to open in the system browser: a one-time ticket, for five minutes, bound to you, this token session, the purpose, `redirectUri` (one of NATIVE_REDIRECT_URIS) and `codeChallenge`. A step-up asks the provider to authenticate you again. The browser lands on `redirectUri?code=…` (or `?error=link_failed` / `reauthentication_failed`): POST /auth/identities/native/complete with the verifier. docs/auth.md, "Native and mobile apps".',
  })
  @ApiCreatedResponse({
    standardSchema: z.object({
      url: z
        .string()
        .describe(
          'The login route with the ticket: open it in the system browser.',
        ),
    }),
  })
  async nativeTicket(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Param('provider') provider: string,
    @Body({ schema: nativeTicketSchema })
    body: z.infer<typeof nativeTicketSchema>,
  ) {
    notWhileImpersonating(user);
    // As the browser's: an address the person proved.
    verifiedEmailOnly(user);
    this.configured(provider);
    return this.native.ticket(user, session, provider, body);
  }

  // The code is 256 random bits, bound to its verifier and this session.
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @UserOnly()
  @Can.Anyone()
  @Post('identities/native/complete')
  @HttpCode(200)
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({
    summary: 'Finish a native link or step-up with its handoff code',
    description:
      "With the token session that asked for the ticket. A link answers the identity (an identity already another account's was refused at the callback: `?error=link_failed`, nothing changed; connected to one since: 409 `identity_taken`). The link is written only now. A step-up answers new tokens with a fresh `auth_time`, as POST /auth/reauthenticate does for a password: send `refreshToken` to revoke the old pair. Two-factor on: without a code, 401 `mfa_required` and the handoff code still works (for its minute); a wrong one spends it.",
  })
  @ApiOkResponse({ standardSchema: nativeCompletedSchema })
  @ApiUnauthorizedResponse({
    description:
      'Unknown, used or expired code, another verifier, user or session; a second factor required or wrong.',
  })
  async nativeComplete(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Body({ schema: nativeCompleteSchema })
    body: z.infer<typeof nativeCompleteSchema>,
    @Ip() ip: string,
  ) {
    const done = await this.native.complete(
      user,
      session,
      {
        code: body.handoffCode,
        codeVerifier: body.codeVerifier,
        refreshToken: body.refreshToken,
        secondFactor: { code: body.code, recoveryCode: body.recoveryCode },
      },
      ip,
    );
    if (done.purpose === 'reauthenticate') {
      return done;
    }
    const identity = (await this.account.identities(user.id)).find(
      (item) => item.provider === done.provider,
    );
    return { purpose: done.purpose, identity };
  }

  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Delete('identities/:provider')
  @HttpCode(204)
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({ summary: 'Disconnect a provider' })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      '`last_sign_in_method`: it is your only way to sign in (no password, passkey or other provider): set a password or register a passkey first.',
  })
  async unlink(
    @CurrentUser() user: UserPrincipal,
    @Param('provider') provider: string,
  ) {
    notWhileImpersonating(user);
    await this.account.unlinkIdentity(user, provider);
  }
}
