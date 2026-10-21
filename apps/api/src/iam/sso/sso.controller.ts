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
  Put,
} from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../access/policies.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { SsoDomainsService } from './sso-domains.service.js';
import { SsoPolicyService } from './sso-policy.service.js';
import { SamlMetadataImport } from './saml-metadata.service.js';
import {
  acceptedSchema,
  connectionSchema,
  createConnectionSchema,
  domainSchema,
  domainViewSchema,
  exemptSchema,
  importedSamlMetadataSchema,
  importSamlMetadataSchema,
  policySchema,
  policyViewSchema,
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
    private readonly policy: SsoPolicyService,
    private readonly samlMetadata: SamlMetadataImport,
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

  @Post('saml/metadata')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @Throttle({ default: { limit: 10, ttl: minutes(1) } })
  @HttpCode(200)
  @ApiOperation({
    summary: "Read a SAML IdP's metadata from its URL (nothing is stored)",
    description:
      "Fetches the https URL (private and metadata addresses refused, no redirects, 10 s, 512 KiB) and answers the entity id, the HTTP-Redirect sign-on URL and the signing certificates, to create or change a SAML connection with. The metadata's own signature is not checked: its trust is the URL. 422 `saml_metadata_url_refused`, `saml_metadata_unreachable`, `saml_metadata_too_large`, `saml_metadata_invalid`.",
  })
  @ApiOkResponse({ standardSchema: importedSamlMetadataSchema })
  @ApiUnprocessableEntityResponse()
  importSamlMetadata(
    @Body({ schema: importSamlMetadataSchema })
    body: z.infer<typeof importSamlMetadataSchema>,
  ) {
    return this.samlMetadata.import(body.url);
  }

  @Post('connections/:id/refresh')
  @Can(AccessPolicy, 'manageSso')
  @HttpCode(202)
  @ApiOperation({
    summary: "Fetch an OpenID Connect connection's discovery document again",
    description:
      'Only an OpenID Connect connection has one: a SAML connection gets 400, an OAuth 2.0 one 409 `sso_no_discovery` (its endpoints are its own fields, usable as soon as it is on).',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  @ApiConflictResponse()
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

  @Get('policy')
  @Can(AccessPolicy, 'manageSso')
  @ApiOperation({
    summary: 'Whether the tenant requires SSO, and who is exempted',
  })
  @ApiOkResponse({ standardSchema: policyViewSchema })
  getPolicy() {
    return this.policy.get();
  }

  @Put('policy')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Require SSO (or stop): members sign in only through a connection',
    description:
      'Turning it on needs an enabled connection, and you signed in through one of them or exempted (else 409 `sso_lockout`: you would lock yourself out). It applies to sessions already open at their next request.',
  })
  @ApiOkResponse({ standardSchema: policyViewSchema })
  @ApiConflictResponse({
    description: '`sso_connection_required`, `sso_lockout`.',
  })
  setPolicy(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Body({ schema: policySchema }) body: z.infer<typeof policySchema>,
    @Ip() ip: string,
  ) {
    return this.policy.setRequired(user, session, body.requireSso, ip);
  }

  @Put('exemptions/:userId')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @ApiOperation({
    summary:
      'Exempt a member from "SSO required" (break-glass): their password and passkey still sign in',
    description:
      'For an emergency administrator, when the IdP is down or misconfigured. Each sign-in it allows is audited (`sso.exemption-used`). Give it to few, with two-factor on.',
  })
  @ApiOkResponse({ standardSchema: policyViewSchema })
  @ApiNotFoundResponse({ description: 'Not an active member.' })
  async exempt(
    @CurrentUser() user: UserPrincipal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body({ schema: exemptSchema }) body: z.infer<typeof exemptSchema>,
    @Ip() ip: string,
  ) {
    await this.policy.exempt(user, userId, body.reason, ip);
    return this.policy.get();
  }

  @Delete('exemptions/:userId')
  @Can(AccessPolicy, 'manageSso')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({ summary: 'End an exemption' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not exempted.' })
  @ApiConflictResponse({
    description: '`sso_lockout`: your own, while it is how you are signed in.',
  })
  async removeExemption(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Ip() ip: string,
  ) {
    await this.policy.removeExemption(user, session, userId, ip);
  }
}
