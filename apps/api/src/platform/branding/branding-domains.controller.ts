import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExcludeController,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { requestHostname } from '../../iam/auth/host-tenant.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { BrandingDomainsService } from './branding-domains.service.js';
import {
  addDomainSchema,
  domainListSchema,
  domainViewSchema,
  publicBrandSchema,
} from './branding.schemas.js';

const acceptedSchema = z.object({ accepted: z.literal(true) });

/**
 * A tenant's custom domains (docs/branding.md, "Custom domains"):
 * `Access.manageDomains`, people only; every change wants a recent
 * sign-in. Adding and verifying respect the operators' branding lock.
 */
@ApiTags('branding')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('branding/domains')
export class BrandingDomainsController {
  constructor(private readonly domains: BrandingDomainsService) {}

  @Get()
  @Can(AccessPolicy, 'manageDomains')
  @ApiOperation({
    summary: "The tenant's custom domains and their verification",
    description:
      '`enabled`: whether this deployment serves custom domains (CUSTOM_DOMAINS); off, adding and verifying answer 404 `custom_domains_off`.',
  })
  @ApiOkResponse({ standardSchema: domainListSchema })
  list() {
    return this.domains.list();
  }

  @Post()
  @Can(AccessPolicy, 'manageDomains')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Add a custom domain: publish its `record`, then verify',
    description:
      "A public hostname (no IP, port or path; not the app's own domain or one under it; an internationalized name is stored in punycode). Point it at the app (a CNAME) and publish the TXT `record`. Audited (`branding.domain-added`). 409 `branding_locked` while the operators lock the branding.",
  })
  @ApiCreatedResponse({ standardSchema: domainViewSchema })
  @ApiBadRequestResponse({ description: '`invalid_hostname`.' })
  @ApiConflictResponse({ description: '`domain_exists`, `branding_locked`.' })
  @ApiNotFoundResponse({ description: '`custom_domains_off`.' })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: addDomainSchema }) body: z.infer<typeof addDomainSchema>,
    @Ip() ip: string,
  ) {
    return this.domains.create(user, body.hostname, ip);
  }

  @Post(':id/verify')
  @Can(AccessPolicy, 'manageDomains')
  @RecentAuthentication()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Look the TXT record up (on the queue): `verified` once found',
    description:
      'The domain routes to the tenant while its record resolves: checked again every night, a record gone stops it. 409 `branding_locked` while locked.',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: '`branding_locked`.' })
  async verify(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.domains.requestVerification(user, id);
    return { accepted: true as const };
  }

  @Delete(':id')
  @Can(AccessPolicy, 'manageDomains')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a custom domain: it stops routing at once',
    description:
      'No brand, no session and no new certificate on that host from then on. Audited (`branding.domain-removed`). Allowed while the branding is locked.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.domains.remove(user, id, ip);
  }
}

/**
 * The brand of the host the request came to, before sign-in: the web app's
 * sign-in page on a tenant's custom domain. The host is the request's own
 * `Host` (never a parameter, never X-Forwarded-Host): a page can only learn
 * the brand of the domain it is on.
 */
@ApiTags('branding')
@Public()
@Controller('branding')
export class HostBrandingController {
  constructor(private readonly domains: BrandingDomainsService) {}

  @Get('host')
  @ApiOperation({
    summary: 'The brand of the host you reached the app on',
    description:
      "No sign-in needed. On a tenant's verified custom domain, its colours, sender name and logos; on any other host (the app's own, an unknown one, a domain removed), every field null. Never names the tenant otherwise. Not cached: a removed domain stops at once.",
  })
  @ApiOkResponse({ standardSchema: publicBrandSchema })
  @Header('Cache-Control', 'no-store')
  host(@Headers('host') host: string | undefined) {
    return this.domains.brandOfHost(requestHostname(host));
  }
}

/**
 * The edge's question (Caddy's on-demand TLS `ask`, and its per-request
 * `forward_auth` on custom hosts): may it serve `domain`? 200 for a
 * verified custom domain of an active tenant, else 404; the status is
 * the answer. Not an API route: not in the OpenAPI document, not rate
 * limited (the edge asks per request), answered in maintenance too
 * (certificates still renew). The edge reaches it on the private network;
 * it refuses the path from outside (caddy/Caddyfile).
 */
@ApiExcludeController()
@Public()
@AllowInMaintenance()
@SkipThrottle()
@Controller('internal/domains')
export class DomainAskController {
  constructor(private readonly domains: BrandingDomainsService) {}

  @Get('allowed')
  @Header('Cache-Control', 'no-store')
  async allowed(@Query('domain') domain: unknown) {
    const tenantId =
      typeof domain === 'string' && domain.length <= 300
        ? await this.domains.tenantOfHost(domain)
        : null;
    if (!tenantId) {
      throw new NotFoundException();
    }
    return { allowed: true };
  }
}
