import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Headers,
  Injectable,
  Ip,
  NotFoundException,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UseGuards,
  Body,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '@nestjs/authentication';
import { Throttle, minutes } from '@nestjs/throttler';
import {
  ApiFoundResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ClsServiceManager } from 'nestjs-cls';
import { z } from 'zod';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { redirectPath, webAppUrl } from '../../core/http/redirect-path.js';
import { TENANT_SCOPE, tenantScope } from '../../core/tenancy/tenant-scope.js';
import type { IamEnv } from '../iam.env.js';
import { Oauth2Sso } from './oauth2-sso.service.js';
import { OidcSso } from './oidc-sso.service.js';
import { SamlSso } from './saml-sso.service.js';
import { SsoAccounts, SsoRefused } from './sso-accounts.service.js';
import { SSO_HANDOFF_TTL_MS, ssoCookie } from './sso-browser.js';
import {
  type SsoConnection,
  SsoConnectionsService,
} from './sso-connections.service.js';

const CONNECTION = Symbol('sso-connection');

/**
 * The enabled connection in the URL (`:tenantId/:connectionId`), found in
 * its tenant's scope, and the rest of the request in that tenant (as an
 * incoming webhook of a tenant is). An unknown tenant or connection, or one
 * that is off: 404, whichever it is.
 */
@Injectable()
export class SsoConnectionGuard implements CanActivate {
  constructor(private readonly connections: SsoConnectionsService) {}

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [CONNECTION]?: SsoConnection }>();
    const { tenantId, connectionId } = request.params as Record<
      string,
      string | undefined
    >;
    const connection =
      tenantId && connectionId
        ? await this.connections.resolveEnabled(tenantId, connectionId)
        : null;
    if (!connection) {
      throw new NotFoundException('No such SSO connection.');
    }
    request[CONNECTION] = connection;
    ClsServiceManager.getClsService().set(
      TENANT_SCOPE,
      tenantScope(connection.tenantId),
    );
    return true;
  }
}

const connectionOf = (request: Request) =>
  (request as Request & { [CONNECTION]: SsoConnection })[CONNECTION];

const loginQuerySchema = z.object({
  redirectTo: redirectPath
    .optional()
    .catch(undefined)
    .describe(
      'A path of the web app to land on (one leading `/`, printable ASCII, no `\\`); anything else is ignored.',
    ),
});

/** What an OpenID Connect or OAuth 2.0 provider sends back: each a string (a repeated one is a 400, not a 500). */
const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  iss: z.string().optional(),
  session_state: z.string().optional(),
});

/** The SAML HTTP-POST binding's form. */
const acsBodySchema = z.object({
  SAMLResponse: z.string().min(1).max(1_000_000),
  RelayState: z.string().max(2048).optional(),
});

/**
 * Signing in through a tenant's SSO connection (docs/auth.md, "Enterprise
 * SSO"). The browser navigates to `login`; the IdP sends it back to the
 * OIDC or OAuth 2.0 callback, or POSTs its SAML response to the ACS, which hands over to
 * `saml/complete`. Every outcome lands on the web app: its `redirectTo`
 * when signed in, else its root with `?error=sso_failed` (why is in the
 * tenant's audit log, never in the URL).
 */
@ApiTags('auth')
@Public()
@AllowInMaintenance()
@UseGuards(SsoConnectionGuard)
@Controller('auth/sso/:tenantId/:connectionId')
export class SsoAuthController {
  constructor(
    private readonly oidc: OidcSso,
    private readonly oauth2: Oauth2Sso,
    private readonly saml: SamlSso,
    private readonly accounts: SsoAccounts,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
  ) {}

  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @Get('login')
  @Redirect()
  @ApiOperation({
    summary:
      "Start signing in with the tenant's identity provider (navigate the browser here)",
  })
  @ApiFoundResponse({
    description:
      'To the IdP; an OpenID Connect connection whose discovery document has not arrived yet: to the web app with `?error=sso_unavailable`.',
  })
  @ApiNotFoundResponse({
    description: 'No such tenant or connection, or it is off.',
  })
  async login(
    @Req() request: Request,
    @Query({ schema: loginQuerySchema })
    { redirectTo }: z.infer<typeof loginQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const connection = connectionOf(request);
    try {
      const { url, binding } =
        connection.protocol === 'oidc'
          ? await this.oidc.start(connection, redirectTo)
          : connection.protocol === 'oauth2'
            ? await this.oauth2.start(connection, redirectTo)
            : await this.saml.start(connection, redirectTo);
      res.append('Set-Cookie', this.cookie().set(binding));
      return { url };
    } catch (error) {
      if (error instanceof SsoRefused) {
        return { url: this.backToWebApp('sso_unavailable') };
      }
      throw error;
    }
  }

  @Get('oidc/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Where an OpenID Connect IdP sends the browser back',
  })
  @ApiFoundResponse({
    description:
      'To the web app: signed in, or `?error=sso_failed` (the reason is audited).',
  })
  @ApiNotFoundResponse({
    description:
      'No such tenant or connection, it is off, or it is not an OpenID Connect connection.',
  })
  oidcCallback(
    @Req() request: Request,
    @Query({ schema: callbackQuerySchema })
    query: z.infer<typeof callbackQuerySchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.codeCallback('oidc', request, query, ip, userAgent, res);
  }

  @Get('oauth2/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Where an OAuth 2.0 provider sends the browser back',
  })
  @ApiFoundResponse({
    description:
      'To the web app: signed in, or `?error=sso_failed` (the reason is audited).',
  })
  @ApiNotFoundResponse({
    description:
      'No such tenant or connection, it is off, or it is not an OAuth 2.0 connection.',
  })
  oauth2Callback(
    @Req() request: Request,
    @Query({ schema: callbackQuerySchema })
    query: z.infer<typeof callbackQuerySchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.codeCallback('oauth2', request, query, ip, userAgent, res);
  }

  /** The authorization code flow's return (OpenID Connect or OAuth 2.0), to the connection's own protocol only. */
  private async codeCallback(
    protocol: 'oidc' | 'oauth2',
    request: Request,
    query: z.infer<typeof callbackQuerySchema>,
    ip: string,
    userAgent: string | undefined,
    res: Response,
  ) {
    const connection = connectionOf(request);
    if (connection.protocol !== protocol) {
      throw new NotFoundException(`Not an ${protocol} connection.`);
    }
    const cookie = this.cookie();
    res.append('Set-Cookie', cookie.clear());
    let label = 'sso';
    try {
      const { identity, redirectTo } = await (
        protocol === 'oidc' ? this.oidc : this.oauth2
      ).finish(
        connection,
        Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ) as Record<string, string>,
        cookie.read(request.headers.cookie),
      );
      label = identity.email ?? identity.subject;
      const userId = await this.accounts.resolve(connection, identity);
      await this.accounts.signIn(connection, userId, {
        ip,
        userAgent,
        authenticatedAt: identity.authenticatedAt,
      });
      return { url: this.webApp(redirectTo).toString() };
    } catch (error) {
      if (error instanceof SsoRefused) {
        await this.accounts.refused(connection, label, error.reason, ip);
        return { url: this.backToWebApp('sso_failed') };
      }
      throw error;
    }
  }

  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @Post('saml/acs')
  @Redirect(undefined, 303)
  @ApiOperation({
    summary:
      'The assertion consumer service: where a SAML IdP POSTs its response',
    description:
      'A form post (`application/x-www-form-urlencoded`, `SAMLResponse`), cross-site by nature: exempt from the CSRF check, which the browser binding (its cookie) and `InResponseTo` replace.',
  })
  @ApiResponse({
    status: 303,
    description:
      'To `saml/complete`, which signs the browser in; or to the web app with `?error=sso_failed`.',
  })
  async acs(
    @Req() request: Request,
    @Body({ schema: acsBodySchema }) body: z.infer<typeof acsBodySchema>,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const connection = connectionOf(request);
    const cookie = this.cookie();
    let label = 'sso';
    try {
      const { identity, requestId, redirectTo } = await this.saml.consume(
        connection,
        body.SAMLResponse,
        cookie.read(request.headers.cookie),
      );
      label = identity.email ?? identity.subject;
      const userId = await this.accounts.resolve(connection, identity);
      const { binding } = await this.saml.handOver(
        connection,
        userId,
        identity.authenticatedAt,
        requestId,
        redirectTo,
      );
      if (binding) {
        res.append('Set-Cookie', cookie.set(binding, SSO_HANDOFF_TTL_MS));
      }
      return { url: this.urlOf(request, 'saml/complete') };
    } catch (error) {
      if (error instanceof SsoRefused) {
        res.append('Set-Cookie', cookie.clear());
        await this.accounts.refused(connection, label, error.reason, ip);
        return { url: this.backToWebApp('sso_failed') };
      }
      throw error;
    }
  }

  @Get('saml/complete')
  @Redirect()
  @ApiOperation({
    summary: 'Signs the browser in once the ACS checked the SAML response',
  })
  @ApiFoundResponse({
    description: 'To the web app: signed in, or `?error=sso_failed`.',
  })
  async samlComplete(
    @Req() request: Request,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const connection = connectionOf(request);
    const cookie = this.cookie();
    res.append('Set-Cookie', cookie.clear());
    try {
      const handed = await this.saml.takeHandOver(
        connection,
        cookie.read(request.headers.cookie),
      );
      await this.accounts.signIn(connection, handed.userId, {
        ip,
        userAgent,
        authenticatedAt: handed.authenticatedAt,
      });
      return { url: this.webApp(handed.redirectTo).toString() };
    } catch (error) {
      if (error instanceof SsoRefused) {
        await this.accounts.refused(connection, 'sso', error.reason, ip);
        return { url: this.backToWebApp('sso_failed') };
      }
      throw error;
    }
  }

  @Get('saml/metadata')
  @Header('Content-Type', 'application/samlmetadata+xml; charset=utf-8')
  @ApiOperation({
    summary: "Our SAML service provider's metadata, for the IdP",
    description:
      'The entity id (this URL), the assertion consumer service, and that assertions must be signed. A document for the IdP to import, not a page.',
  })
  @ApiProduces('application/samlmetadata+xml')
  @ApiOkResponse({ description: 'SAML 2.0 metadata (XML).' })
  @ApiNotFoundResponse({
    description:
      'No such tenant or connection, it is off, or it is not a SAML connection.',
  })
  samlMetadata(@Req() request: Request) {
    const connection = connectionOf(request);
    if (connection.protocol !== 'saml') {
      throw new NotFoundException('Not a SAML connection.');
    }
    return this.saml.metadata(connection);
  }

  /** Secure (and `__Host-`) as the session's cookie (SESSION_COOKIE_SECURE). */
  private cookie() {
    return ssoCookie(this.config.get('SESSION_COOKIE_SECURE', { infer: true }));
  }

  /** A sibling route of this connection, on this API. */
  private urlOf(request: Request, path: string) {
    const { tenantId, connectionId } = request.params as Record<string, string>;
    const base = `${this.config.get('APP_URL', { infer: true })}`;
    return `${base}/v1/auth/sso/${tenantId}/${connectionId}/${path}`;
  }

  /** `value` on the web app (a stored path checked again), else its root. */
  private webApp(value: unknown) {
    return webAppUrl(value, `${webUrl(this.config)}`);
  }

  private backToWebApp(error: string) {
    const url = this.webApp(undefined);
    url.searchParams.set('error', error);
    return url.toString();
  }
}
