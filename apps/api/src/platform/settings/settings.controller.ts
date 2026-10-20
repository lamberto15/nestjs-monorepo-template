import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  platformSettingSchema,
  type SetPlatformSettingDto,
  setPlatformSettingSchema,
  type SetSettingDto,
  setMineSchema,
  setSettingSchema,
  settingOverrideSchema,
  settingViewSchema,
  unsetSettingQuerySchema,
} from './setting.schemas.js';
import { SettingsService } from './settings.service.js';

/**
 * Settings and feature flags: what the features declared, with the value
 * each caller gets. Reading is for anyone; setting a value for everyone
 * or a team takes Access.manageSettings; a user sets their own
 * preferences (settings scoped `user`) themselves.
 */
@ApiTags('settings')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Every setting and flag, with your value of each',
    description:
      "Your value: the operators' enforced value, else your own, else your team's, else your tenant's (or a rollout), else the operators' value for every tenant, else the default. Settings not marked public show only to those who manage settings.",
  })
  @ApiOkResponse({ standardSchema: listSchema(settingViewSchema) })
  async list(@CurrentUser() user: Principal) {
    const all = await this.access.can(user, 'manageSettings', 'Access');
    return { items: await this.settings.effective(user, { all }) };
  }

  @Get(':key')
  @Can.Anyone()
  @ApiOperation({ summary: 'One setting, with your value' })
  @ApiOkResponse({ standardSchema: settingViewSchema })
  @ApiNotFoundResponse()
  async get(@CurrentUser() user: Principal, @Param('key') key: string) {
    const declaration = this.settings.declaration(key);
    if (
      declaration.public === false &&
      !(await this.access.can(user, 'manageSettings', 'Access'))
    ) {
      throw new NotFoundException(`No setting "${key}".`);
    }
    return this.settings.view(declaration, user);
  }

  @Put(':key/mine')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Set your own value of a setting (a preference)',
    description: 'Only settings whose scopes include `user`. Audited.',
  })
  @ApiOkResponse({ standardSchema: settingViewSchema })
  @ApiBadRequestResponse({
    description: 'Not set per user, or an invalid value.',
  })
  @ApiNotFoundResponse()
  setMine(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Body({ schema: setMineSchema }) body: z.infer<typeof setMineSchema>,
    @Ip() ip: string,
  ) {
    return this.settings.setMine(user, key, body.value, ip);
  }

  @Delete(':key/mine')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Drop your own value of a setting: back to the shared one',
  })
  @ApiOkResponse({ standardSchema: settingViewSchema })
  @ApiNotFoundResponse()
  unsetMine(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Ip() ip: string,
  ) {
    return this.settings.unsetMine(user, key, ip);
  }

  @Put(':key/platform')
  @Can(AccessPolicy, 'manageSettings')
  @OperatorOnly()
  @ApiOperation({
    summary: 'Set a setting for every tenant (operators)',
    description:
      "The runtime default of every tenant, below each tenant's own values; `enforced: true` puts it above them all (a kill switch). Operators only. Applies on the next request. Audited.",
  })
  @ApiOkResponse({ standardSchema: platformSettingSchema })
  @ApiBadRequestResponse({
    description:
      'A value its schema refuses (validation_failed), or one the deployment does not allow (setting_not_allowed).',
  })
  @ApiNotFoundResponse()
  setPlatform(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Body({ schema: setPlatformSettingSchema }) body: SetPlatformSettingDto,
    @Ip() ip: string,
  ) {
    return this.settings.setPlatform(user, key, body, ip);
  }

  @Delete(':key/platform')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AccessPolicy, 'manageSettings')
  @OperatorOnly()
  @ApiOperation({
    summary:
      "Remove the value for every tenant (operators): each tenant's own, or the default, holds again",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async unsetPlatform(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Ip() ip: string,
  ) {
    await this.settings.unsetPlatform(user, key, ip);
  }

  @Get(':key/overrides')
  @Can(AccessPolicy, 'manageSettings')
  @ApiOperation({ summary: 'The stored values of a setting, every scope' })
  @ApiOkResponse({ standardSchema: listSchema(settingOverrideSchema) })
  @ApiNotFoundResponse()
  async overrides(@Param('key') key: string) {
    return { items: await this.settings.overrides(key) };
  }

  @Put(':key')
  @Can(AccessPolicy, 'manageSettings')
  @ApiOperation({
    summary: 'Set a setting for everyone, a team, or one principal',
    description:
      "Replaces what that scope had, in the caller's tenant. A flag at the tenant scope may take `rollout` (a percentage) instead of a value. Applies on the next request. Audited.",
  })
  @ApiOkResponse({ standardSchema: settingOverrideSchema })
  @ApiBadRequestResponse({
    description:
      'A scope the setting does not take, a value its schema refuses, a rollout on something that is not a flag at the tenant scope (validation_failed).',
  })
  @ApiNotFoundResponse({
    description: 'No such setting, team or principal.',
  })
  set(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Body({ schema: setSettingSchema }) body: SetSettingDto,
    @Ip() ip: string,
  ) {
    return this.settings.set(user, key, body, ip);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AccessPolicy, 'manageSettings')
  @ApiOperation({
    summary: "Remove a scope's value: back to the next scope's, or the default",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async unset(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Query({ schema: unsetSettingQuerySchema })
    query: z.infer<typeof unsetSettingQuerySchema>,
    @Ip() ip: string,
  ) {
    await this.settings.unset(user, key, query.scope, query.scopeId, ip);
  }
}
