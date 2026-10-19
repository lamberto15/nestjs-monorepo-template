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
  Query,
  Res,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  type SessionRecord,
} from '@nestjs/authentication';
import type { Response } from 'express';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { ListQuery } from '../../core/http/list-query.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { AUDIT_LIST, PRINCIPAL_LIST, USER_LIST } from './access.lists.js';
import {
  auditPageSchema,
  catalogSchema,
  createdRoleSchema,
  principalSchema,
  roleViewSchema,
  userViewSchema,
} from './access.schemas.js';
import { PrincipalsService } from './principals.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { SessionOnly, UserOnly } from '../auth/user-only.decorator.js';
import { RequiresSwitch } from '../auth/deployment-switch.js';
import { ImpersonationService } from '../account/impersonation.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessAdminService } from './access-admin.service.js';
import { InvitationsService } from './invitations.service.js';
import { ApiClientsService } from './api-clients.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { AccessPolicy } from './policies.js';

const permissionSchema = z.object({
  subject: z.string().min(1).meta({ example: 'Note' }),
  action: z.string().min(1).meta({ example: 'read' }),
  conditions: z
    .array(
      z.object({
        key: z.string().min(1).meta({ example: 'mine' }),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(10),
  fields: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe(
      'Only these restrictable fields of the subject (GET /access/catalog); [] for none of them; leave out for all.',
    ),
});

const roleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  permissions: z.array(permissionSchema).max(100),
});

/** When grants end, by role id: temporary access. Roles not listed never end. */
const roleExpiresAt = z
  .record(z.uuid(), z.iso.datetime({ offset: true }))
  .optional()
  .describe(
    'When each grant ends, by role id (temporary access); the others never do.',
  );

// Strict: a `password` (or `name` on a change) is refused, not ignored:
// administrators never set another person's account (docs/tenancy.md).
const createUserSchema = z.strictObject({
  email: z.email(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('The name a new account starts with; its owner changes it.'),
  roleIds: z.array(z.uuid()).default([]),
  roleExpiresAt,
  teamIds: z
    .array(z.uuid())
    .optional()
    .describe('The teams the user belongs to.'),
});

const updateUserSchema = z.strictObject({
  active: z
    .boolean()
    .optional()
    .describe('The membership in this tenant, not the account.'),
  roleIds: z.array(z.uuid()).optional(),
  roleExpiresAt,
  teamIds: z.array(z.uuid()).optional(),
});

const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
});

const pendingInvitationSchema = invitationSchema.extend({
  name: z.string().nullable(),
  roleIds: z.array(z.uuid()),
  roleExpiresAt: z
    .record(z.uuid(), z.iso.datetime({ offset: true }))
    .describe(
      'When each grant ends once accepted, by role id; the others never do.',
    ),
  teamIds: z.array(z.uuid()),
  invitedBy: z.string(),
  expired: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** Requests a UTC day (platform/usage); null: no quota. */
const dailyQuota = z
  .number()
  .int()
  .min(1)
  .nullable()
  .optional()
  .describe(
    'Requests a UTC day; past it, 429 quota_exceeded until midnight UTC. null: no quota.',
  );

const clientSchema = z.object({
  name: z.string().trim().min(1).max(80),
  dailyQuota,
  roleIds: z
    .array(z.uuid())
    .default([])
    .describe('Roles on top of what every client may do (clientPermissions).'),
  roleExpiresAt,
  keyExpiresAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('When the first key stops working; leave out for never.'),
});
const clientChangesSchema = z.object({
  active: z
    .boolean()
    .optional()
    .describe('false: every key is refused from the next request.'),
  dailyQuota,
  roleIds: z.array(z.uuid()).optional(),
  roleExpiresAt,
});
// No body at all is fine: rotate with the defaults.
const rotateSchema = z.preprocess(
  (body) => body ?? {},
  z.object({
    graceSeconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 86_400)
      .default(0)
      .describe(
        'How long the current keys keep working, so the system can switch: 0 stops them now.',
      ),
    expiresAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('When the new key stops working.'),
  }),
);

const keyViewSchema = z.object({
  id: z.uuid(),
  keyId: z
    .string()
    .describe("The key's public id: the middle of <prefix>_<id>_<secret>."),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso
    .datetime()
    .nullable()
    .describe('Recorded at most once a minute.'),
});
const clientViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
  dailyQuota: z
    .number()
    .int()
    .nullable()
    .describe(
      'Requests a UTC day (GET /v1/access/clients/{id}/usage); null: none.',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  keys: z
    .array(keyViewSchema)
    .describe('Never the keys themselves, nor their hashes.'),
  roles: z.array(
    z.object({ roleId: z.uuid(), expiresAt: z.iso.datetime().nullable() }),
  ),
  webhookEndpoints: z
    .number()
    .int()
    .optional()
    .describe(
      'How many webhook endpoints the client has (GET …/{id}/webhook-endpoints), so a client chooser needs no request per client. Absent with WEBHOOKS=off, not 0.',
    ),
});
const clientWithKeySchema = clientViewSchema.extend({
  key: z
    .string()
    .describe('The API key: `Authorization: Bearer <key>`. Shown this once.'),
});

/**
 * Access administration: roles, users, API clients and the audit log. User
 * sessions only (an API key never reaches it), each route behind its own
 * permission. You can only grant what you hold yourself without conditions.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@Controller('access')
export class AccessController {
  constructor(
    private readonly admin: AccessAdminService,
    private readonly clients: ApiClientsService,
    private readonly permissions: PermissionCatalog,
    private readonly audit: AuditService,
    private readonly impersonation: ImpersonationService,
    private readonly invitationsService: InvitationsService,
    private readonly principals: PrincipalsService,
  ) {}

  @Get('catalog')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary:
      'Every permission that exists: subjects, actions and the conditions each may carry; and the system jobs, with what each may do',
  })
  @ApiOkResponse({ standardSchema: catalogSchema })
  catalog() {
    return {
      subjects: this.permissions.view(),
      // Who acts without a user (`system:<key>` in the audit log), and its permissions.
      systemJobs: this.permissions.systemJobsView(),
    };
  }

  @Get('roles')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'The roles, with their permissions and member counts',
  })
  @ApiOkResponse({ standardSchema: listSchema(roleViewSchema) })
  async roles() {
    return { items: await this.admin.listRoles() };
  }

  @Get('roles/:id')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'One role, with its permissions and member count',
  })
  @ApiOkResponse({ standardSchema: roleViewSchema })
  @ApiNotFoundResponse()
  role(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getRole(id);
  }

  @Post('roles')
  @Can(AccessPolicy, 'manageRoles')
  @ApiOperation({ summary: 'Create a role' })
  @ApiCreatedResponse({
    description: 'The new role id.',
    standardSchema: createdRoleSchema,
  })
  @ApiConflictResponse({ description: 'A role with this name exists.' })
  createRole(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: roleSchema }) body: z.infer<typeof roleSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.createRole(user, body, ip);
  }

  @Patch('roles/:id')
  @Can(AccessPolicy, 'manageRoles')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Replace a role: name, description and permissions',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The built-in Administrator role.' })
  async updateRole(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: roleSchema }) body: z.infer<typeof roleSchema>,
    @Ip() ip: string,
  ) {
    await this.admin.updateRole(user, id, body, ip);
  }

  @Delete('roles/:id')
  @Can(AccessPolicy, 'manageRoles')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a role: its members lose its permissions' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The built-in Administrator role.' })
  async deleteRole(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.admin.deleteRole(user, id, ip);
  }

  @Get('users')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'The users, with their role ids, newest first',
    description:
      "Filter flat (`?active=true&email.contains=@example.com`, a team's members with `?teamId=<id>` or `?teamId.in=<id>,<id>`: those in it, not in the teams below) or with `filter` (and/or groups), sort with `sort=-createdAt`, pick fields with `fields=email,name`; each parameter lists what it takes. GET /v1/lists/User describes it.",
  })
  @ApiOkResponse({ standardSchema: pageSchema(userViewSchema) })
  async users(@Query({ schema: USER_LIST.schema }) query: ListQuery) {
    return USER_LIST.pick(
      await this.admin.listUsers(query, USER_LIST.where(query)),
      query,
    );
  }

  @Get('users/:id')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'One member of this tenant, with their role grants and teams',
  })
  @ApiOkResponse({ standardSchema: userViewSchema })
  @ApiNotFoundResponse({ description: 'Not a member of this tenant.' })
  user(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getUser(id);
  }

  @Post('users')
  @Can(AccessPolicy, 'manageUsers')
  // Roles are privileges (a stale stolen session must not hand them out);
  // an invitation without any stays frequent administration.
  @RecentAuthentication({
    when: ({ body }) => Array.isArray(body?.roleIds) && body.roleIds.length > 0,
  })
  @HttpCode(202)
  @ApiOperation({
    summary: 'Invite someone to this tenant',
    description:
      "The address is emailed a link (WEB_URL/accept-invitation?token=…, valid INVITATION_TTL_HOURS). A new address chooses its password with it; an existing account accepts while signed in (POST /auth/invitations/accept). The membership, with these roles and teams, comes then. The answer is the same whether or not the address has an account; nobody sets another person's password.",
  })
  @ApiAcceptedResponse({ standardSchema: invitationSchema })
  createUser(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createUserSchema })
    body: z.infer<typeof createUserSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.createUser(user, body, ip);
  }

  @Patch('users/:id')
  @Can(AccessPolicy, 'manageUsers')
  // Roles are privileges; reactivating a membership brings its access back
  // (deactivating isn't asked).
  @RecentAuthentication({
    when: ({ body }) => body?.roleIds !== undefined || body?.active === true,
  })
  @HttpCode(204)
  @ApiOperation({
    summary: "Change a member's membership; only what is sent changes",
    description:
      "Its activation, roles and teams in this tenant: never the account (its name, its password), which is its owner's. A deactivation ends their sessions and tokens in this tenant. The last active administrator stays.",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'Deactivating yourself, or removing the last administrator.',
  })
  async updateUser(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateUserSchema })
    body: z.infer<typeof updateUserSchema>,
    @Ip() ip: string,
  ) {
    await this.admin.updateUser(user, id, body, ip);
  }

  @Get('invitations')
  @Can(AccessPolicy, 'manageUsers')
  @ApiOperation({ summary: "This tenant's invitations not accepted yet" })
  @ApiOkResponse({ standardSchema: listSchema(pendingInvitationSchema) })
  async invitations() {
    return { items: await this.invitationsService.pending() };
  }

  @Post('invitations/:id/resend')
  @Can(AccessPolicy, 'manageUsers')
  // A new link that hands out the invitation's roles: as inviting with roles.
  @RecentAuthentication()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a pending invitation again: a new link and expiry',
    description:
      'Expired or not. The previous link stops working; the roles, their ends (`roleExpiresAt`) and the teams stay as they were. You must be able to grant its roles, as when inviting.',
  })
  @ApiAcceptedResponse({ standardSchema: invitationSchema })
  @ApiNotFoundResponse({ description: 'No pending invitation of this id.' })
  resendInvitation(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.admin.resendInvitation(user, id, ip);
  }

  @Delete('invitations/:id')
  @Can(AccessPolicy, 'manageUsers')
  @HttpCode(204)
  @ApiOperation({ summary: 'Withdraw an invitation: its link stops working' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async revokeInvitation(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.invitationsService.revoke(user, id, ip);
  }

  /**
   * Support: act as this user in this browser, for IMPERSONATION_TTL_MINUTES.
   * Everything done meanwhile is audited as "admin as user". Stop with
   * POST /auth/impersonation/stop.
   */
  @Post('users/:id/impersonate')
  @RequiresSwitch('IMPERSONATION')
  @SessionOnly()
  @Can(AccessPolicy, 'impersonate')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Act as this user (support)',
    description:
      "Replaces your session with one of the user's, for IMPERSONATION_TTL_MINUTES. Never an administrator, never nested. GET /auth/me shows the impersonator.",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Yourself, or already impersonating.' })
  async impersonate(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const { cookie } = await this.impersonation.start(user, session, id, ip);
    res.append('Set-Cookie', cookie);
  }

  /**
   * The picker of whom a setting's override, a rollout or a filter is for:
   * the members and API clients GET /access/users and /access/clients
   * already show, to the same callers (`open`), searched by name or
   * address. Nothing they don't show: the tenant's own (memberships, row-
   * level security), the same fields.
   */
  @Get('principals')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: "Search the tenant's users and API clients, as principal keys",
    description:
      "`?q=` matches a part of a user's name or address, or of a client's name, whatever the case (`%` and `_` are the characters); `?kind=user|client`, `?active=true`, `?sort=label`. Cursor pages. Each item's `key` (`user:<id>`, `client:<id>`) is what a setting's user scope takes as `scopeId`. Clients only while API_CLIENTS is on.",
  })
  @ApiOkResponse({ standardSchema: pageSchema(principalSchema) })
  async principalsList(
    @Query({ schema: PRINCIPAL_LIST.schema }) query: ListQuery,
  ) {
    return PRINCIPAL_LIST.pick(await this.principals.page(query), query);
  }

  @Get('clients')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'open')
  @ApiOperation({ summary: 'The API clients (never their keys)' })
  @ApiOkResponse({ standardSchema: listSchema(clientViewSchema) })
  async apiClients() {
    return { items: await this.clients.list() };
  }

  @Get('clients/:id')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'open')
  @ApiOperation({ summary: 'One API client (never its keys)' })
  @ApiOkResponse({ standardSchema: clientViewSchema })
  @ApiNotFoundResponse()
  apiClient(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getClient(id);
  }

  @Post('clients')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'manageClients')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Create an API client: its key is in the response, this once',
    description:
      'With its roles and daily quota at once, in one transaction: never a client without them.',
  })
  @ApiCreatedResponse({ standardSchema: clientWithKeySchema })
  @ApiConflictResponse({ description: 'An API client with this name exists.' })
  createClient(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: clientSchema }) body: z.infer<typeof clientSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.createClient(user, body, ip);
  }

  @Post('clients/:id/rotate')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'manageClients')
  @RecentAuthentication()
  @HttpCode(200)
  @ApiOperation({
    summary: 'A new key; the current ones stop after graceSeconds (0: now)',
  })
  @ApiOkResponse({ standardSchema: clientWithKeySchema })
  @ApiNotFoundResponse()
  rotateClient(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: rotateSchema }) body: z.infer<typeof rotateSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.rotateClient(user, id, body, ip);
  }

  @Delete('clients/:id/keys/:keyId')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'manageClients')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one key now' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async revokeKey(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @Ip() ip: string,
  ) {
    await this.admin.revokeClientKey(user, id, keyId, ip);
  }

  @Patch('clients/:id')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'manageClients')
  // Roles are privileges; reactivating brings its keys back (revoking isn't asked).
  @RecentAuthentication({
    when: ({ body }) => body?.roleIds !== undefined || body?.active === true,
  })
  @ApiOperation({
    summary:
      'Revoke (active: false) or reactivate a client; change its roles or daily quota',
  })
  @ApiOkResponse({ standardSchema: clientViewSchema })
  @ApiNotFoundResponse()
  updateClient(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: clientChangesSchema })
    body: z.infer<typeof clientChangesSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.updateClient(user, id, body, ip);
  }

  @Delete('clients/:id')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'manageClients')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete an API client for good: its keys stop at once',
    description:
      'Its keys, role grants, usage and webhook endpoints go with it; the audit log keeps what it did. To stop it and keep it, revoke it instead (PATCH `active: false`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async deleteClient(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.admin.deleteClient(user, id, ip);
  }

  @Get('audit')
  @Can(AccessPolicy, 'readAudit')
  @ApiOperation({
    summary: 'The audit log, newest first',
    description:
      "Filter flat (`?action.startsWith=note.&at.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=action,-at`, pick fields with `fields=at,action,actor`; each parameter lists what it takes. Who acted: by key (`actor=user:<id>`), or by name or address (`actorLabel.contains=ada`: the label the entry stored, a member's name or address, an API client's name; this tenant's only). Each entry names its actor as they are called now (`actorName`: a member or former member, an API client of the tenant; null for `system:<key>`, `anonymous` and deleted accounts) besides the label it stored (`actorLabel`). GET /v1/lists/Audit describes it.",
  })
  @ApiOkResponse({ standardSchema: auditPageSchema })
  async auditLog(@Query({ schema: AUDIT_LIST.schema }) query: ListQuery) {
    const page = await this.audit.page(query, AUDIT_LIST.where(query));
    return AUDIT_LIST.pick(
      { ...page, items: await this.audit.withActorNames(page.items) },
      query,
    );
  }
}
