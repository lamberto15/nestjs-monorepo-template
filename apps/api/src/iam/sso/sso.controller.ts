import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../access/policies.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { SsoDomainsService } from './sso-domains.service.js';
import {
  acceptedSchema,
  connectionSchema,
  createConnectionSchema,
  domainSchema,
  domainViewSchema,
  updateConnectionSchema,
} from './sso.schemas.js';

/**
 * A tenant's single sign-on (docs/auth.md, "Enterprise SSO"): its SAML and
 * OpenID Connect connections and the email domains it verified.
 * `Access.manageSso`; every change wants a recent sign-in.
 */
@ApiTags('sso')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('sso')
export class SsoController {
  constructor(
    private readonly connections: SsoConnectionsService,
    private readonly domains: SsoDomainsService,
  ) {}

  @Get('connections')
  @Can(AccessPolicy, 'manageSso')
  @ApiOperation({ summary: "The tenant's SSO connections" })
  @ApiOkResponse({ standardSchema: listSchema(connectionSchema) })
  async listConnections() {
    return { items: await this.connections.list() };
  }

  @Get('connections/:id')
  @Can(AccessPolicy, 'manageSso')
  @ApiOperation({ summary: 'One SSO connection (never its client secret)' })
  @ApiOkResponse({ standardSchema: connectionSchema })
  @ApiNotFoundResponse()
  getConnection(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(id);
  }

  @Post('connections')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Add a SAML or OpenID Connect connection (off by default)',
    description:
      "An OpenID Connect connection's discovery document is fetched on the queue: `oidc.metadataFetchedAt` says when it arrived, `oidc.metadataError` why not. It signs nobody in before.",
  })
  @ApiCreatedResponse({ standardSchema: connectionSchema })
  @ApiConflictResponse({
    description: '`sso_connection_name_taken`: on the `name` field.',
  })
  createConnection(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createConnectionSchema })
    body: z.infer<typeof createConnectionSchema>,
    @Ip() ip: string,
  ) {
    return this.connections.create(user, body, ip);
  }

  @Patch('connections/:id')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @ApiOperation({
    summary:
      'Change a connection: turn it on or off, rotate its secret or certificates',
  })
  @ApiOkResponse({ standardSchema: connectionSchema })
  @ApiNotFoundResponse()
  updateConnection(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateConnectionSchema })
    body: z.infer<typeof updateConnectionSchema>,
    @Ip() ip: string,
  ) {
    return this.connections.update(user, id, body, ip);
  }

  @Delete('connections/:id')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a connection (the identities it linked stay)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async removeConnection(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.connections.remove(user, id, ip);
  }

  @Post('connections/:id/refresh')
  @Can(AccessPolicy, 'manageSso')
  @HttpCode(202)
  @ApiOperation({
    summary: "Fetch an OpenID Connect connection's discovery document again",
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  @ApiNotFoundResponse()
  async refreshConnection(@Param('id', ParseUUIDPipe) id: string) {
    await this.connections.refreshMetadata(id);
    return { accepted: true as const };
  }

  @Get('domains')
  @Can(AccessPolicy, 'manageSso')
  @ApiOperation({
    summary: "The tenant's email domains and their verification",
  })
  @ApiOkResponse({ standardSchema: listSchema(domainViewSchema) })
  async listDomains() {
    return { items: await this.domains.list() };
  }

  @Post('domains')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Add a domain to verify: publish its `record`, then verify',
  })
  @ApiCreatedResponse({ standardSchema: domainViewSchema })
  @ApiConflictResponse({ description: '`sso_domain_exists`.' })
  createDomain(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: domainSchema }) body: z.infer<typeof domainSchema>,
    @Ip() ip: string,
  ) {
    return this.domains.create(user, body.domain, ip);
  }

  @Post('domains/:id/verify')
  @Can(AccessPolicy, 'manageSso')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Look the TXT record up (on the queue): `verified` once found',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  @ApiNotFoundResponse()
  async verifyDomain(@Param('id', ParseUUIDPipe) id: string) {
    await this.domains.requestVerification(id);
    return { accepted: true as const };
  }

  @Delete('domains/:id')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a domain: its addresses no longer sign in or provision',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async removeDomain(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.domains.remove(user, id, ip);
  }
}
