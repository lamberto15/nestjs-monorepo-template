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
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
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
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { CustomFieldPolicy } from './custom-field.policy.js';
import {
  type CreateCustomFieldDto,
  createCustomFieldSchema,
  customFieldListQuerySchema,
  customFieldSchema,
  reorderCustomFieldsSchema,
  type UpdateCustomFieldDto,
  updateCustomFieldSchema,
} from './custom-field.schemas.js';
import type { CustomFieldDefinition } from './custom-field.types.js';
import { CustomFieldsService } from './custom-fields.service.js';

/** A definition as the API shows it (`default`, not the column's name). */
const view = ({ defaultValue, ...field }: CustomFieldDefinition) => ({
  ...field,
  default: defaultValue ?? null,
});

/**
 * Custom fields: what administrators add to a subject's records at runtime
 * (`Note`), without a migration. Reading a subject's fields takes reading
 * the subject; changing them takes Access.manageCustomFields.
 */
@ApiTags('custom fields')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(
    private readonly fields: CustomFieldsService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Get()
  @Can.Anyone() // Checked below, on the subject.
  @ApiOperation({
    summary: "A subject's custom fields, in their order",
    description:
      'For anyone who may read the subject: forms and tables are built from them. Inactive fields only with includeInactive=true.',
  })
  @ApiOkResponse({ standardSchema: listSchema(customFieldSchema) })
  @ApiNotFoundResponse({ description: 'The subject takes no custom fields.' })
  async list(
    @CurrentUser() user: Principal,
    @Query({ schema: customFieldListQuerySchema })
    query: z.infer<typeof customFieldListQuerySchema>,
  ) {
    this.fields.declaration(query.subject);
    await this.authorization.authorize(
      CustomFieldPolicy,
      'read',
      user,
      query.subject,
    );
    const items = await this.fields.definitions(query.subject, {
      includeInactive: query.includeInactive,
    });
    return { items: items.map(view) };
  }

  @Post()
  @Can(AccessPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: 'Add a field to a subject',
    description: 'Audited. The key is set once and never reused.',
  })
  @ApiCreatedResponse({ standardSchema: customFieldSchema })
  @ApiBadRequestResponse({
    description:
      'Invalid definition: options, validation or default that the type does not take.',
  })
  @ApiConflictResponse({
    description:
      'The key exists (custom_field_exists), or the subject has 100 active fields (custom_field_limit).',
  })
  async create(
    @CurrentUser() user: Principal,
    @Body({ schema: createCustomFieldSchema }) body: CreateCustomFieldDto,
    @Ip() ip: string,
  ) {
    return view(await this.fields.create(user, body, ip));
  }

  @Put('order')
  @Can(AccessPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: "Reorder a subject's fields",
    description:
      'The fields listed come first, in that order; the others follow in theirs.',
  })
  @ApiOkResponse({ standardSchema: listSchema(customFieldSchema) })
  async reorder(
    @CurrentUser() user: Principal,
    @Body({ schema: reorderCustomFieldsSchema })
    body: z.infer<typeof reorderCustomFieldsSchema>,
    @Ip() ip: string,
  ) {
    const items = await this.fields.reorder(user, body.subject, body.ids, ip);
    return { items: items.map(view) };
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: 'Change a field',
    description:
      'Audited with what changed. A type change is refused while records hold values (except text → longText, email/url → text or longText); so is removing a choice records hold.',
  })
  @ApiOkResponse({ standardSchema: customFieldSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      'Records hold values the change would break (custom_field_in_use).',
  })
  async update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateCustomFieldSchema }) body: UpdateCustomFieldDto,
    @Ip() ip: string,
  ) {
    return view(await this.fields.update(user, id, body, ip));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AccessPolicy, 'manageCustomFields')
  @ApiOperation({
    summary: 'Deactivate a field',
    description:
      'No longer accepted on writes nor exported; the values records hold are kept, and PATCH { active: true } brings it back.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async deactivate(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.fields.deactivate(user, id, ip);
  }
}
