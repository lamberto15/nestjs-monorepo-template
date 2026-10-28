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
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { TEMPLATE_LIST } from './template.list.js';
import {
  type CreateTemplateDto,
  createTemplateSchema,
  templatePageSchema,
  templatePreviewSchema,
  templateSchema,
  templateSubjectsSchema,
  type UpdateTemplateDto,
  updateTemplateSchema,
} from './template.schemas.js';
import { TemplatesService } from './templates.service.js';

const VALIDATION =
  'An unknown subject, a value the subject’s create body refuses or does not have (`values.<field>`), a unit that does not exist, more than 100 templates (validation_failed).';
const FIELD_FORBIDDEN =
  'A value sets a field your permissions do not let you set (field_forbidden, naming it).';

/**
 * Record templates: values to prefill a new record, under a name. Private
 * to their owner, shared with a unit, or tenant-wide
 * (`Access.manageTemplates`). A template creates nothing: preview it, then
 * create through the subject's own route, which checks it all as any create.
 */
@ApiTags('templates')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // A template is its owner's or shared; the subject's own create permission is checked.
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('subjects')
  @ApiOperation({
    summary: 'The records that take templates',
    description:
      'The subjects whose records you may create, with the create fields you may set in a template.',
  })
  @ApiOkResponse({ standardSchema: templateSubjectsSchema })
  subjects(@CurrentUser() user: RequestPrincipal) {
    return this.templates.subjects(user);
  }

  @Get()
  @ApiOperation({
    summary: 'The record templates you see',
    description:
      'Yours, those shared with your units and the tenant-wide ones, of the records you may create. `?subject=Note`, `?visibility=unit`, `?name.contains=`, `?sort=name`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: templatePageSchema })
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: TEMPLATE_LIST.schema }) query: ListQuery,
  ) {
    return TEMPLATE_LIST.pick(await this.templates.page(user, query), query);
  }

  @Post()
  @ApiOperation({
    summary: 'Save a record template',
    description:
      "Values to prefill the subject's create body (`values`), checked against that body as it is now and your own field permissions. System-set values (ids, numbers, owners, dates) are not fields of it and are refused. `visibility`: `private` (default), `unit` (with `unitId`: an organizational unit you belong to) or `tenant` (`Access.manageTemplates`). The name is unique per subject and place, whatever its case. Audited (`recordTemplate.created`).",
  })
  @ApiCreatedResponse({ standardSchema: templateSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({
    description: `You may not create the subject; not allowed to share it so; ${FIELD_FORBIDDEN}`,
  })
  @ApiConflictResponse({ description: 'The name is taken (conflict).' })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createTemplateSchema }) dto: CreateTemplateDto,
    @Ip() ip: string,
  ) {
    return this.templates.create(user, dto, ip);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One record template you see' })
  @ApiOkResponse({ standardSchema: templateSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.templates.get(user, id);
  }

  @Get(':id/preview')
  @ApiOperation({
    summary: 'A record template, ready to prefill a create',
    description:
      "The template checked again against the subject's create body as it is now and your permissions: `values` is what still holds, `dropped` what the schema or your permissions no longer allow. Create the record with `POST` on the subject's own route, which validates and authorizes it as any create; a template never creates or bypasses anything.",
  })
  @ApiOkResponse({ standardSchema: templatePreviewSchema })
  @ApiForbiddenResponse({ description: 'You may not create the subject.' })
  @ApiNotFoundResponse()
  preview(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.templates.preview(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a record template',
    description:
      'Only what is sent changes (never the subject; `values` replaces all values). Its owner changes it; a shared one, a template manager too (`Access.manageTemplates`). Audited (`recordTemplate.updated`, with what changed).',
  })
  @ApiOkResponse({ standardSchema: templateSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({
    description: `Not yours to change or to share so; ${FIELD_FORBIDDEN}`,
  })
  @ApiConflictResponse({ description: 'The name is taken (conflict).' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateTemplateSchema }) dto: UpdateTemplateDto,
    @Ip() ip: string,
  ) {
    return this.templates.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a record template',
    description:
      'Its owner; a shared one, a template manager too. Audited (`recordTemplate.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Not yours to delete.' })
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.templates.remove(user, id, ip);
  }
}
