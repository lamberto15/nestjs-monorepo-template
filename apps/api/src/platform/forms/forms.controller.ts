import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Idempotent } from '@nestjs/idempotency';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import { RequireFlag } from '../settings/require-flag.js';
import { FORMS_ENABLED } from './form-settings.js';
import { FORM_LIST } from './form.list.js';
import { FormPolicy } from './form.policy.js';
import {
  type CreateFormDto,
  createFormSchema,
  formDraftSchema,
  formSchema,
  formVersionSchema,
  formVersionSummarySchema,
  type PublishFormDto,
  publishFormSchema,
  publishedFormSchema,
  type SaveDraftDto,
  saveDraftSchema,
  type UpdateFormDto,
  updateFormSchema,
} from './form.schemas.js';
import { FormsService } from './forms.service.js';

const INVALID =
  'The definition breaks a rule, each at its path (`definition.sections.0.fields.2.options`): duplicate keys, a choice without options, a default of the wrong type, a pattern RE2 refuses, HTML in a label, a published key with another type, a limit (validation_failed).';
const CONFLICT =
  'The revision you edited is not the form\'s any more (form_conflict, with the current `revision`): read it again.';

/**
 * Runtime forms: drafts, immutable published versions, archive. Off until
 * the tenant turns on `forms.enabled` (404). Editing takes `Form.edit`;
 * reading published forms `Form.read` or `Form.submit` (docs/forms.md).
 */
@ApiTags('forms')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@RequireFlag(FORMS_ENABLED)
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @Can.Anyone() // Checked by the service: editors see every form, others the published active ones.
  @ApiOperation({
    summary: 'Forms',
    description:
      'Editors (and those who read responses) see every form; whoever may read or submit, the published, active ones. `?status=`, `?slug=`, `?name.contains=`; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(formSchema) })
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: FORM_LIST.schema }) query: ListQuery,
  ) {
    return FORM_LIST.pick(await this.forms.page(user, query), query);
  }

  @Post()
  @Can(FormPolicy, 'edit')
  @Idempotent({ required: false })
  @ApiOperation({
    summary: 'Create a form',
    description:
      'A draft (revision 1), with no sections unless `definition` is sent. Audited (`form.created`).',
  })
  @ApiHeader(idempotencyKeyHeader(false))
  @ApiCreatedResponse({ standardSchema: formSchema })
  @ApiBadRequestResponse({ description: INVALID })
  @ApiConflictResponse({ description: 'The slug is taken (form_slug_taken).' })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createFormSchema }) dto: CreateFormDto,
    @Ip() ip: string,
  ) {
    return this.forms.create(user, dto, ip);
  }

  @Get(':id')
  @Can.Anyone() // Checked by the service.
  @ApiOperation({ summary: 'One form (without its definition)' })
  @ApiOkResponse({ standardSchema: formSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.forms.get(user, id);
  }

  @Patch(':id')
  @Can(FormPolicy, 'edit')
  @ApiOperation({
    summary: "Change a form's name, slug or description",
    description:
      'Not versioned: they apply at once. Audited (`form.updated`, from and to).',
  })
  @ApiOkResponse({ standardSchema: formSchema })
  @ApiConflictResponse({ description: 'The slug is taken (form_slug_taken).' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateFormSchema }) dto: UpdateFormDto,
    @Ip() ip: string,
  ) {
    return this.forms.update(user, id, dto, ip);
  }

  @Delete(':id')
  @Can(FormPolicy, 'edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a form never published',
    description: 'Audited (`form.deleted`). A published form is archived.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'It was published (form_published).' })
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.forms.remove(user, id, ip);
  }

  @Get(':id/draft')
  @Can(FormPolicy, 'edit')
  @ApiOperation({ summary: "A form's draft and its revision" })
  @ApiOkResponse({ standardSchema: formDraftSchema })
  @ApiNotFoundResponse()
  draft(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.forms.draft(user, id);
  }

  @Put(':id/draft')
  @Can(FormPolicy, 'edit')
  @ApiOperation({
    summary: "Replace a form's draft",
    description:
      'With the `revision` you edited; the answer carries the next one. Checked as a publication is. Published versions never change. Audited (`form.draft-saved`, without the definition).',
  })
  @ApiOkResponse({ standardSchema: formDraftSchema })
  @ApiBadRequestResponse({ description: INVALID })
  @ApiConflictResponse({ description: CONFLICT })
  @ApiNotFoundResponse()
  saveDraft(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: saveDraftSchema }) dto: SaveDraftDto,
    @Ip() ip: string,
  ) {
    return this.forms.saveDraft(user, id, dto, ip);
  }

  @Post(':id/publish')
  @Can(FormPolicy, 'edit')
  @ApiOperation({
    summary: 'Publish the draft as the next version',
    description:
      'The draft of `revision` becomes version 1, 2, 3…, an immutable snapshot that new submissions answer; earlier submissions keep theirs. Audited (`form.published`).',
  })
  @ApiCreatedResponse({ standardSchema: formVersionSchema })
  @ApiBadRequestResponse({ description: `${INVALID} Or no field at all.` })
  @ApiConflictResponse({
    description: `${CONFLICT} Or the draft is published already (form_unchanged), or the form is archived (form_archived).`,
  })
  @ApiNotFoundResponse()
  publish(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: publishFormSchema }) dto: PublishFormDto,
    @Ip() ip: string,
  ) {
    return this.forms.publish(user, id, dto, ip);
  }

  @Post(':id/archive')
  @Can(FormPolicy, 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a form',
    description:
      'It takes no more submissions and submitters no longer see it; its versions and submissions stay. Audited (`form.archived`).',
  })
  @ApiOkResponse({ standardSchema: formSchema })
  @ApiNotFoundResponse()
  archive(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.forms.setStatus(user, id, 'archived', ip);
  }

  @Post(':id/unarchive')
  @Can(FormPolicy, 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unarchive a form',
    description: 'Audited (`form.unarchived`).',
  })
  @ApiOkResponse({ standardSchema: formSchema })
  @ApiNotFoundResponse()
  unarchive(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.forms.setStatus(user, id, 'active', ip);
  }

  @Get(':id/published')
  @Can.Anyone() // Checked by the service: any right on forms.
  @ApiOperation({
    summary: 'The version to fill in now',
    description:
      'Its definition and `versionId`, which a submission sends back. 404 while the form is unpublished or archived.',
  })
  @ApiOkResponse({ standardSchema: publishedFormSchema })
  @ApiNotFoundResponse()
  published(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.forms.published(user, id);
  }

  @Get(':id/versions')
  @Can.Anyone() // Checked by the service.
  @ApiOperation({ summary: "A form's published versions, newest first" })
  @ApiOkResponse({ standardSchema: listSchema(formVersionSummarySchema) })
  @ApiNotFoundResponse()
  versions(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.forms.versions(user, id);
  }

  @Get(':id/versions/:version')
  @Can.Anyone() // Checked by the service.
  @ApiOperation({
    summary: 'One published version, with its definition',
    description: 'What the submissions of that version answered.',
  })
  @ApiOkResponse({ standardSchema: formVersionSchema })
  @ApiNotFoundResponse()
  version(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.forms.version(user, id, version);
  }
}
