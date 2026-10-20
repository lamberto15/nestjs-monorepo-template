import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { newPassword } from '../account/account.schemas.js';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { OperatorOnly } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { SessionOnly, UserOnly } from '../auth/user-only.decorator.js';
import { InvitationsService } from './invitations.service.js';
import { AccessPolicy } from './policies.js';
import { TenantSwitchService } from './tenant-switch.service.js';
import { TENANT_LIST } from './tenants.lists.js';
import { TenantsService } from './tenants.service.js';

const myTenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  current: z.boolean().describe('The tenant this session or token acts in.'),
});

const switchSchema = z.object({
  tenantId: z.uuid().describe('One of GET /auth/tenants.'),
});

const acceptSchema = z.object({
  token: z.string().min(1).max(200),
  password: newPassword
    .optional()
    .describe('A new address: the password its account starts with.'),
  name: z.string().trim().min(1).max(120).optional(),
});

const acceptedInvitationSchema = z.object({
  tenantId: z.uuid(),
  accountCreated: z.boolean(),
});

const tenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  active: z.boolean(),
  operator: z.boolean(),
  // Optional in the document though always sent: a field the typed client
  // requires would break every client's fixtures of a tenant.
  createdBySignUp: z
    .boolean()
    .optional()
    .describe(
      'Made by a self sign-up (TENANT_SIGN_UP), not by the operators. Always sent.',
    ),
  // Optional in the document, as createdBySignUp: always sent.
  deletionRequestedAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .describe(
      'An operator asked for its deletion (POST /v1/tenants/{id}/deletion); null: none pending. Always sent.',
    ),
  deletionScheduledFor: z.iso
    .datetime()
    .nullable()
    .optional()
    .describe(
      'When it is erased (TENANT_DELETION_GRACE_DAYS after the request), unless cancelled before; null: none pending. Always sent.',
    ),
  deletionStartedAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .describe('The erase began: it can no longer be cancelled. Always sent.'),
  // Optional in the document, as createdBySignUp: always sent.
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe(
      'Its parent in a holding’s tenant tree (docs/tenancy.md, "The tenant tree"); null: a root. Always sent.',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const requestDeletionSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(48)
    .describe('The tenant’s slug, typed again: what you mean to delete.'),
});

const tenantName = z.string().trim().min(1).max(120);
const tenantSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(48)
  .describe('A short handle: lowercase letters, digits and dashes (`acme`).');

const createdTenantSchema = tenantSchema.extend({
  administrator: z
    .object({
      email: z.string(),
      status: z
        .enum(['invited'])
        .describe(
          'Always `invited`: the address got a link to accept (a new address chooses its password, an existing account accepts signed in). Whether it has an account is never read here, so never told.',
        ),
      expiresAt: z.iso.datetime().describe('When the link stops working.'),
    })
    .describe('The first administrator: invited at `administratorEmail`.'),
});

const updateTenantSchema = z
  .object({
    name: tenantName.optional(),
    slug: tenantSlug.optional(),
    active: z
      .boolean()
      .optional()
      .describe(
        'false: nobody acts in it (its sessions end, API keys stop, connections end, jobs are skipped); true: its data, members and API keys are back. Never for the operator tenant.',
      ),
    parentId: z
      .uuid()
      .nullable()
      .optional()
      .describe(
        'Places it under that tenant in the tenant tree (with everything below it); null makes it a root. Members of the parent with `Access.readConsolidated` then read it, read-only. Never the operator tenant, on either side; never under itself or one of its descendants (409 `tenant_tree_cycle`).',
      ),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one of name, slug, active, parentId.',
  });

const createTenantSchema = z.object({
  name: tenantName,
  slug: tenantSlug,
  administratorEmail: z
    .email()
    .describe(
      'Its first administrator: an account at this address (made, and invited to choose a password, when there is none).',
    ),
  parentId: z
    .uuid()
    .optional()
    .describe(
      'Its parent in a holding’s tenant tree (never the operator tenant): members of the parent with `Access.readConsolidated` read it, read-only.',
    ),
});

/**
 * A user's tenants and the switch between them (docs/tenancy.md): one
 * origin, the session carries the tenant it acts in, and switching re-issues
 * the session (a new cookie: anything bound to the old one, a realtime
 * connection, reconnects). Token clients sign in again with `tenantId`
 * (POST /auth/token).
 */
@ApiTags('auth')
@Controller('auth')
export class TenantSwitchController {
  constructor(
    private readonly switcher: TenantSwitchService,
    private readonly invitations: InvitationsService,
  ) {}

  @UserOnly()
  @Can.Anyone()
  @DuringMfaEnrollment()
  @Get('tenants')
  @ApiCookieAuth('user-session')
  @ApiOperation({
    summary: 'The tenants you belong to',
    description:
      'The active memberships of active tenants, the last chosen first. `current` is the one this session acts in. While impersonating, only that one.',
  })
  @ApiOkResponse({ standardSchema: listSchema(myTenantSchema) })
  async tenants(@CurrentUser() user: UserPrincipal) {
    return { items: await this.switcher.tenantsOf(user) };
  }

  @SessionOnly()
  @Can.Anyone()
  @DuringMfaEnrollment()
  @Post('tenant')
  @HttpCode(204)
  @ApiCookieAuth('user-session')
  @ApiOperation({
    summary: 'Act in another of your tenants',
    description:
      'Re-issues the session (a new cookie) in that tenant. Never while impersonating. Realtime connections reconnect to hear the new tenant.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not one of your tenants.' })
  async switch(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord,
    @Body({ schema: switchSchema }) body: z.infer<typeof switchSchema>,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const issued = await this.switcher.switch(user, session, body.tenantId, ip);
    if (!issued) {
      throw new UnauthorizedException(); // signed out meanwhile
    }
    res.append('Set-Cookie', issued.cookie);
  }

  /**
   * An invitation's link (WEB_URL/accept-invitation?token=…) posts here. A
   * new address chooses its password (`password`, and a `name`); an existing
   * account accepts while signed in as itself. Either way the membership
   * comes now, with the invitation's roles and units.
   */
  @UserOnly({ optional: true })
  @Can.Anyone()
  // The global limit only: a token is 256 random bits (nothing to guess),
  // and the one hash a new account costs waits in PasswordHashLimiter.
  @DuringMfaEnrollment()
  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation to a tenant',
    description:
      '400 `password_required`: a new address, send `password` (and `name`). 401 `sign_in_required`: the address has an account, sign in to it and accept again. 403 `invitation_other_account`: you are signed in as another account. 400 `invitation_invalid`: unknown, used or expired. A new account signs in afterwards (POST /auth/sign-in); a signed-in one switches to the tenant (POST /auth/tenant).',
  })
  @ApiOkResponse({ standardSchema: acceptedInvitationSchema })
  @ApiBadRequestResponse({
    description:
      '`invitation_invalid`, `password_required`, `password_breached`.',
  })
  async acceptInvitation(
    @CurrentUser() user: UserPrincipal | null,
    @Body({ schema: acceptSchema }) body: z.infer<typeof acceptSchema>,
    @Ip() ip: string,
  ) {
    const { tenantId, accountCreated } = await this.invitations.accept(
      body.token,
      { password: body.password, name: body.name },
      user,
      ip,
    );
    return { tenantId, accountCreated };
  }
}

/**
 * The deployment's tenants, for its operators (`@OperatorOnly()`: the
 * operator tenant's members with `Access.manageTenants`): list, make, read
 * and change one (rename, its slug, deactivate), and delete one after a
 * grace period (`/{id}/deletion`). The export is the platform's
 * (TenantExportController: a data transfer).
 */
@ApiTags('tenants')
@Controller('tenants')
@OperatorOnly()
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'The tenants, newest first (operators)',
    description:
      'Filter flat (`?active=false&name.contains=acme`) or with `filter`, sort with `sort=name`, page with `cursor` (`nextCursor`) or `page`, pick fields with `fields=slug,name`; each parameter lists what it takes. GET /v1/lists/Tenant describes it.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(tenantSchema) })
  async list(@Query({ schema: TENANT_LIST.schema }) query: ListQuery) {
    return TENANT_LIST.pick(
      await this.tenants.page(query, TENANT_LIST.where(query)),
      query,
    );
  }

  @Get(':id')
  @Etag()
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({ summary: 'One tenant (operators)' })
  @ApiHeader(ifNoneMatchHeader())
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.get(id);
  }

  @Patch(':id')
  @Etag()
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary:
      'Rename a tenant, change its slug, (de)activate it, move it in the tenant tree (operators)',
    description:
      'Audited (`tenant.updated`) in your tenant and in that one. Deactivated (`active: false`): its sessions and token families end (its members sign in again, into another of their tenants), its API keys and invitations stop, a sign-in never starts in it, its realtime connections end, its jobs are skipped. Nothing else is deleted: `active: true` gives back its data, memberships and API keys. docs/tenancy.md, "Operators".',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`tenant_slug_taken` (on `errors[].path` `slug`); `operator_tenant`: the operator tenant is never deactivated, nor in a tenant tree; `tenant_deletion_pending`: `active: true` while its deletion is pending (cancel it first), or a `parentId` whose deletion is pending; `tenant_tree_cycle`: a `parentId` that is this tenant or below it.',
  })
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateTenantSchema })
    body: z.infer<typeof updateTenantSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    // If-Match under the tenant's lock: two operators can't both win.
    return this.tenants.update(
      user,
      id,
      body,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }

  @Post()
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Create a tenant and its first administrator (operators)',
    description:
      'The tenant gets the built-in and declared roles; its first administrator is invited at `administratorEmail` (`administrator.status: invited`): the link makes the account when there is none, or adds the existing one once its owner accepts signed in. Whether the address has an account is never told (invite-only, docs/tenancy.md).',
  })
  @ApiCreatedResponse({ standardSchema: createdTenantSchema })
  @ApiNotFoundResponse({ description: '`parentId`: no such tenant.' })
  @ApiConflictResponse({
    description:
      '`tenant_slug_taken` (on `errors[].path` `slug`); `single_tenant`: the deployment has its one tenant (TENANCY=single); `operator_tenant`: a `parentId` that is the operator tenant; `tenant_deletion_pending`: a `parentId` whose deletion is pending.',
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createTenantSchema })
    body: z.infer<typeof createTenantSchema>,
    @Ip() ip: string,
  ) {
    return this.tenants.createWithAdministrator(user, body, ip);
  }
  @Post(':id/deletion')
  @Can(AccessPolicy, 'manageTenants')
  @RecentAuthentication()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a tenant, after a grace period (operators)',
    description:
      'Send its `slug` to confirm. The tenant is deactivated now (as `PATCH { active: false }`: its sessions, tokens, API keys and connections end) and erased TENANT_DELETION_GRACE_DAYS later by a worker: every row of it, its stored files, its queued jobs and workflows. Until the erase starts, DELETE /v1/tenants/{id}/deletion cancels it. Asked again while one is pending: that one, unchanged. Wants a recent sign-in (`reauthentication_required`: POST /v1/auth/reauthenticate). Audited (`tenant.deletion-requested`) in your tenant and in that one; the erase as `tenant.purged`, outside any tenant. docs/tenancy.md, "Deleting a tenant".',
  })
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiBadRequestResponse({
    description: '`validation_failed` on `slug`: not this tenant’s.',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`operator_tenant`: the operator tenant is never deleted; `tenant_has_children`: it has children in the tenant tree (move them first).',
  })
  requestDeletion(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: requestDeletionSchema })
    body: z.infer<typeof requestDeletionSchema>,
    @Ip() ip: string,
  ) {
    return this.tenants.requestDeletion(user, id, body.slug, ip);
  }

  @Delete(':id/deletion')
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Keep a tenant: cancel its pending deletion (operators)',
    description:
      'Until the erase starts. The tenant stays deactivated: `PATCH { active: true }` brings it back. Audited (`tenant.deletion-cancelled`) in your tenant and in that one.',
  })
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiNotFoundResponse({ description: 'No deletion is pending.' })
  @ApiConflictResponse({
    description: '`tenant_deletion_started`: the erase is running.',
  })
  cancelDeletion(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.tenants.cancelDeletion(user, id, ip);
  }
}
