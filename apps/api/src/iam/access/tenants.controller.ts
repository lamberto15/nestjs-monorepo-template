import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { newPassword } from '../account/account.schemas.js';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { OperatorOnly } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SessionOnly, UserOnly } from '../auth/user-only.decorator.js';
import { InvitationsService } from './invitations.service.js';
import { AccessPolicy } from './policies.js';
import { TenantSwitchService } from './tenant-switch.service.js';
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(48)
    .describe('A short handle: lowercase letters, digits and dashes (`acme`).'),
  administratorEmail: z
    .email()
    .describe(
      'Its first administrator: an account at this address (made, and invited to choose a password, when there is none).',
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
 * operator tenant's members with `Access.manageTenants`). Roadmap 1b adds
 * the rest (deactivating, exporting and deleting a tenant).
 */
@ApiTags('tenants')
@Controller('tenants')
@OperatorOnly()
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({ summary: 'Every tenant (operators)' })
  @ApiOkResponse({ standardSchema: listSchema(tenantSchema) })
  async list() {
    return { items: await this.tenants.list() };
  }

  @Post()
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Create a tenant and its first administrator (operators)',
    description:
      'The tenant gets the built-in and declared roles; the administrator is the account at `administratorEmail` (made and invited when there is none).',
  })
  @ApiCreatedResponse({ standardSchema: tenantSchema })
  @ApiConflictResponse({
    description:
      '`tenant_slug_taken`; `single_tenant`: the deployment has its one tenant (TENANCY=single).',
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createTenantSchema })
    body: z.infer<typeof createTenantSchema>,
    @Ip() ip: string,
  ) {
    return this.tenants.createWithAdministrator(user, body, ip);
  }
}
