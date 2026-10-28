import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import {
  appliedSchema,
  applyBodySchema,
  configBundleSchema,
  previewBodySchema,
  previewSchema,
} from './config-bundle.schemas.js';
import { ConfigBundlePolicy } from './config-bundle.policy.js';
import { ConfigBundlesService } from './config-bundles.service.js';

/**
 * Promoting configuration (docs/settings.md, "Promoting configuration"):
 * export this tenant's settings and custom roles as a checksummed bundle,
 * preview it in another environment's tenant, apply it there. In the
 * caller's tenant; Access.manageSettings and Access.manageRoles.
 */
@ApiTags('config-bundles')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@Controller('config-bundles')
export class ConfigBundlesController {
  constructor(private readonly bundles: ConfigBundlesService) {}

  @Get('export')
  @Can(ConfigBundlePolicy, 'manage')
  @ApiOperation({
    summary: "This tenant's settings and custom roles as a bundle",
    description:
      'Tenant-scope setting values (flag rollouts and rules, a role condition by role name) and the custom roles with their permissions, with a SHA-256 checksum. No secrets, users, grants, API clients or records.',
  })
  @ApiOkResponse({ standardSchema: configBundleSchema })
  export() {
    return this.bundles.export();
  }

  @Post('preview')
  @Can(ConfigBundlePolicy, 'manage')
  @HttpCode(200)
  @ApiOperation({
    summary: 'What applying a bundle here would change (a dry run)',
    description:
      'Validates the bundle against this deployment (format, checksum, declared settings, their values, the permission catalog) and diffs it against this tenant. Changes nothing. Hand `targetVersion` to apply.',
  })
  @ApiOkResponse({ standardSchema: previewSchema })
  preview(
    @Body({ schema: previewBodySchema })
    body: z.infer<typeof previewBodySchema>,
  ) {
    return this.bundles.preview(body.bundle);
  }

  @Post('apply')
  @Can(ConfigBundlePolicy, 'manage')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Apply a previewed bundle to this tenant, all or nothing',
    description:
      'Roles first, then settings, in one transaction, each through its own checks and audit entry, plus one config-bundle.applied entry. Additive: nothing the bundle lacks is removed.',
  })
  @ApiOkResponse({ standardSchema: appliedSchema })
  @ApiBadRequestResponse({
    description:
      'validation_failed: the bundle is invalid here (the preview lists why).',
  })
  @ApiConflictResponse({
    description: 'config_changed: the tenant changed since the preview.',
  })
  apply(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: applyBodySchema }) body: z.infer<typeof applyBodySchema>,
    @Ip() ip: string,
  ) {
    return this.bundles.apply(user, body.bundle, body.targetVersion, ip);
  }
}
