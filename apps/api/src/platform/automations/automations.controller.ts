import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import type { ListQuery } from '../../core/http/list-query.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  AUTOMATION_RULE_LIST,
  AUTOMATION_RUN_LIST,
} from './automation.list.js';
import { AutomationRulePolicy } from './automation.policy.js';
import {
  automationRuleSchema,
  automationRunSchema,
  automationSimulationSchema,
  automationSubjectSchema,
  type CreateAutomationRuleDto,
  createAutomationRuleSchema,
  type SimulateAutomationRuleDto,
  simulateAutomationRuleSchema,
  type UpdateAutomationRuleDto,
  updateAutomationRuleSchema,
} from './automation.schemas.js';
import { AutomationsService } from './automations.service.js';

const VALIDATION =
  'A subject that takes no rules, a field it lacks, conditions its list refuses (`filters.<key>`), an action it cannot do or a value its field refuses (`actions.<n>`) (validation_failed).';
const FIELD_FORBIDDEN =
  'Not allowed by your permissions, or its conditions use a field your permissions hide (field_forbidden).';

/**
 * Tenant automation rules (docs/automations.md): when a record is created
 * or changed and matches the conditions, the actions run, as the user who
 * activated the rule. Reading takes `AutomationRule.read`, everything else
 * `AutomationRule.manage` (users only, never while impersonating).
 */
@ApiTags('automation-rules')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session.' })
@ApiForbiddenResponse({ description: FIELD_FORBIDDEN })
@Controller('automation-rules')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({
    summary: 'The automation rules',
    description: '`?status=active`, `?subject=Note`, `?name.contains=`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(automationRuleSchema) })
  async list(@Query({ schema: AUTOMATION_RULE_LIST.schema }) query: ListQuery) {
    return AUTOMATION_RULE_LIST.pick(await this.automations.page(query), query);
  }

  @Get('subjects')
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({
    summary: 'What rules may be about',
    description:
      'The subjects that take automation rules, the fields a trigger may watch and an action may set, and whether they take tags.',
  })
  @ApiOkResponse({ standardSchema: listSchema(automationSubjectSchema) })
  subjects() {
    return { items: this.automations.subjects() };
  }

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @Can(AutomationRulePolicy, 'manage')
  @ApiOperation({
    summary: 'Simulate a rule',
    description:
      'What a draft rule would do, without doing it: its conditions matched against the most recently changed records you may read (or `recordIds`), at most `limit` (50), each action checked under your permissions. No write, no notification, no webhook. `truncated`: more may match. A `field` trigger is not simulated (`triggerSimulated: false`): records are checked as they are now.',
  })
  @ApiOkResponse({ standardSchema: automationSimulationSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  simulate(
    @CurrentUser() user: Principal,
    @Body({ schema: simulateAutomationRuleSchema }) dto: SimulateAutomationRuleDto,
  ) {
    return this.automations.simulate(user, dto);
  }

  @Post()
  @Can(AutomationRulePolicy, 'manage')
  @ApiOperation({
    summary: 'Create a rule',
    description:
      'A draft: it runs once activated. At most 5 actions. Audited (`automation-rule.created`).',
  })
  @ApiCreatedResponse({ standardSchema: automationRuleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  create(
    @CurrentUser() user: Principal,
    @Body({ schema: createAutomationRuleSchema }) dto: CreateAutomationRuleDto,
    @Ip() ip: string,
  ) {
    return this.automations.create(user, dto, ip);
  }

  @Get(':id')
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({ summary: 'One automation rule' })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.automations.get(id);
  }

  @Patch(':id')
  @Can(AutomationRulePolicy, 'manage')
  @ApiOperation({
    summary: 'Change a rule',
    description:
      'Only what is sent changes. A change of its trigger, conditions or actions is a new `version`, and an active rule becomes a draft until activated again. Audited (`automation-rule.updated`).',
  })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateAutomationRuleSchema }) dto: UpdateAutomationRuleDto,
    @Ip() ip: string,
  ) {
    return this.automations.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AutomationRulePolicy, 'manage')
  @ApiOperation({
    summary: 'Delete a rule',
    description: 'With its runs. Audited (`automation-rule.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.automations.remove(user, id, ip);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @Can(AutomationRulePolicy, 'manage')
  @ApiOperation({
    summary: 'Activate a rule',
    description:
      'It runs from now on, as you, with your permissions as they are at each run (checked again now). At most 20 active rules. Audited (`automation-rule.activated`).',
  })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiConflictResponse({ description: 'Active already (automation_active).' })
  @ApiNotFoundResponse()
  activate(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.automations.activate(user, id, ip);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @Can(AutomationRulePolicy, 'manage')
  @ApiOperation({
    summary: 'Disable a rule',
    description:
      'It stops at once: runs already queued do nothing. Audited (`automation-rule.disabled`, reason `manual`).',
  })
  @ApiOkResponse({ standardSchema: automationRuleSchema })
  @ApiNotFoundResponse()
  disable(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.automations.disable(user, id, ip);
  }

  @Get(':id/runs')
  @Can(AutomationRulePolicy, 'read')
  @ApiOperation({
    summary: "A rule's runs",
    description:
      'What each run did, or why it failed (`status=failed`, `error`); newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(automationRunSchema) })
  @ApiNotFoundResponse()
  async runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: AUTOMATION_RUN_LIST.schema }) query: ListQuery,
  ) {
    return AUTOMATION_RUN_LIST.pick(await this.automations.runs(id, query), query);
  }
}
