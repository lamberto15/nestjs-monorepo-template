import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  Redirect,
  UnauthorizedException,
} from '@nestjs/common';
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
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccountService } from './account.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { notWhileImpersonating } from './account.schemas.js';
import { ReauthenticationService } from './reauthentication.service.js';

const identitySchema = z.object({
  provider: z.string(),
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
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
  @Redirect()
  @ApiOperation({
    summary: 'Start signing in with a provider (navigate the browser here)',
    description:
      'With `link=true`, a signed-in session that is not recent (REAUTHENTICATION_MAX_AGE_MINUTES) is redirected to the web app (`redirectTo`, else its root) with `?error=reauthentication_required`: check GET /auth/reauthenticate first.',
  })
  @ApiQuery({
    name: 'redirectTo',
    required: false,
    description: 'A path of the web app to land on.',
  })
  @ApiQuery({
    name: 'link',
    required: false,
    description: '`true`: connect the provider to the signed-in account.',
  })
  @ApiFoundResponse({
    description:
      'To the provider; or, linking from a stale session, to the web app with `?error=reauthentication_required`.',
  })
  login(
    @CurrentUser() user: UserPrincipal | null,
    @CurrentSession() session: unknown,
    @Param('provider') provider: string,
    @Query('redirectTo') redirectTo?: string,
    @Query('link') link?: string,
  ) {
    if (link === 'true') {
      if (!user) {
        throw new UnauthorizedException();
      }
      notWhileImpersonating(user);
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
   * `redirectTo` (a path of the web app, else its root) with `?error=`. The
   * path is accepted by the package's rule for its own redirects
   * (`safeRedirectPath`, @nestjs/authentication utils/crypto.util.js, not
   * exported): starts with one `/`, no `\` (a URL parser reads it as `/`),
   * printable ASCII only (a tab or a newline is dropped by the parser, so
   * `/%09/evil` would mean `//evil`), at most 2,048 characters. Then the
   * URL built must still be the web app's: anything else goes to its root.
   */
  private backToWebApp(redirectTo: string | undefined, error: string) {
    const web = new URL(`${webUrl(this.config)}/`);
    const safe =
      redirectTo !== undefined &&
      redirectTo.startsWith('/') &&
      !redirectTo.startsWith('//') &&
      !redirectTo.includes('\\') &&
      redirectTo.length <= 2048 &&
      /^[\x21-\x7e]+$/.test(redirectTo);
    let url = new URL(safe ? redirectTo : '/', web);
    if (url.origin !== web.origin) {
      url = new URL('/', web);
    }
    url.searchParams.set('error', error);
    return url.toString();
  }

  @Public()
  @Get('oidc/:provider/callback')
  @Redirect()
  @ApiOperation({ summary: 'Where the provider sends the browser back' })
  @ApiFoundResponse({ description: 'To the web app.' })
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
  ) {
    this.configured(provider);
    return this.account.signInWithProvider(provider, query);
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
    description: 'It is your only way to sign in: set a password first.',
  })
  async unlink(
    @CurrentUser() user: UserPrincipal,
    @Param('provider') provider: string,
  ) {
    notWhileImpersonating(user);
    await this.account.unlinkIdentity(user, provider);
  }
}
