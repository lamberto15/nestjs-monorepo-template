import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  type SessionRecord,
  SessionService,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
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
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenantScope } from '../../core/tenancy/tenant-scope.js';
import { notWhileImpersonating } from '../account/account.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { OperatorOnly } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SessionOnly, UserOnly } from '../auth/user-only.decorator.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AccessPolicy } from './policies.js';
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
    private readonly accounts: UsersRepository,
    private readonly sessions: SessionService,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
  ) {}

  @UserOnly()
  @Can.Anyone()
  @Get('tenants')
  @ApiCookieAuth('user-session')
  @ApiOperation({
    summary: 'The tenants you belong to',
    description:
      'The active memberships of active tenants, the last chosen first. `current` is the one this session acts in.',
  })
  @ApiOkResponse({ standardSchema: listSchema(myTenantSchema) })
  async tenants(@CurrentUser() user: UserPrincipal) {
    const rows = await this.accounts.memberships(user.id);
    return {
      items: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        current: row.id === user.tenantId,
      })),
    };
  }

  @SessionOnly()
  @Can.Anyone()
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
    // An impersonation stays in the tenant it began in.
    notWhileImpersonating(user);
    if (!(await this.accounts.isMember(user.id, body.tenantId))) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'You are not a member of this tenant.',
      });
    }
    // A new session id for the new tenant, as for any change of privilege.
    const issued = await this.sessions.rotate(session, {
      metadata: { ...session.metadata, tenantId: body.tenantId },
    });
    if (!issued) {
      throw new UnauthorizedException(); // signed out meanwhile
    }
    await this.accounts.selectTenant(user.id, body.tenantId);
    // Audited in the tenant entered (the request's scope is the one left).
    await this.tenancy.run(tenantScope(body.tenantId), () =>
      this.audit.record(
        { ...user, tenantId: body.tenantId },
        {
          action: 'auth.tenant-switched',
          targetType: 'tenant',
          targetId: body.tenantId,
          details: { from: user.tenantId },
          ip,
        },
      ),
    );
    res.append('Set-Cookie', issued.cookie);
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
  @ApiConflictResponse({ description: '`tenant_slug_taken`.' })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createTenantSchema })
    body: z.infer<typeof createTenantSchema>,
    @Ip() ip: string,
  ) {
    return this.tenants.createWithAdministrator(user, body, ip);
  }
}
