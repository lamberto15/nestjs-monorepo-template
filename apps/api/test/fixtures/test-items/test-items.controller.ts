import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
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
import { AuthorizationService, Can } from '@nestjs/authorization';
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
  ApiPreconditionFailedResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { and } from 'drizzle-orm';
import {
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../../src/core/http/etag.js';
import { ApiListQuery } from '../../../src/core/http/list-docs.js';
import { pageSchema } from '../../../src/core/http/pagination.js';
import { AccessService } from '../../../src/iam/access/access.service.js';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import { idempotencyKeyHeader } from '../../../src/platform/idempotency/idempotency.openapi.js';
import { principalScope } from '../../../src/platform/idempotency/idempotency.scopes.js';
import { RecordPresenter } from '../../../src/platform/records/record-contract.js';
import { deleteDocs } from '../../../src/platform/records/record-restore.routes.js';
import { TEST_ITEM_LIST } from './test-item.list.js';
import { TestItemPolicy } from './test-item.policy.js';
import { TEST_ITEM } from './test-item.record.js';
import {
  type CreateTestItemDto,
  type TestItem,
  TEST_ITEM_SCHEMAS,
  type UpdateTestItemDto,
} from './test-item.schemas.js';
import { TestItemsService } from './test-items.service.js';

const SCHEMAS = TEST_ITEM_SCHEMAS;

/**
 * Test items: the HTTP routes, nothing else (test-items.service.ts does the work).
 * The recycle bin's restore route and the capabilities' routes (tags, comments…) come
 * from test-item.record.ts (test-items.module.ts).
 */
@ApiTags('test-items')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('test-items')
export class TestItemsController {
  constructor(
    private readonly testItems: TestItemsService,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly presenter: RecordPresenter,
  ) {}

  @Post()
  // A retry with the same key gets the first answer instead of a second record.
  @Idempotent({ required: true, scope: principalScope })
  @Can(TestItemPolicy, 'create')
  @ApiOperation({
    summary: 'Create a test item',
    description:
      'Send a new Idempotency-Key per record and the same one on every retry. Audited.',
  })
  @ApiHeader(idempotencyKeyHeader(true))
  @ApiCreatedResponse({ standardSchema: SCHEMAS.response })
  @ApiBadRequestResponse({
    description:
      'The body fails the schema, or the Idempotency-Key is missing.',
  })
  @ApiConflictResponse({
    description: 'A request with this Idempotency-Key is still running.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'This Idempotency-Key was used for a different request.',
  })
  async create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: SCHEMAS.create }) dto: CreateTestItemDto,
  ) {
    await this.assertFields(user, 'create', dto);
    return this.presenter.one(user, await this.testItems.create(user, dto));
  }

  /** Only those the caller may read: filtered in the query, not after. */
  @Get()
  @Etag()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The test items you may read, newest first',
    description:
      'Filter flat or with `filter`, sort with `sort`, pick fields with `fields`; each parameter lists what it takes.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })
  @ApiListQuery(TEST_ITEM_LIST)
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query() raw: Record<string, unknown>,
  ) {
    const query = TEST_ITEM_LIST.parse(raw);
    const page = await this.testItems.findPage(
      and(
        // The recycle bin (?deleted=true, with softDelete) is for those who may restore.
        await this.access.sqlFilter(
          user,
          'TestItem',
          query.deleted ? 'restore' : 'read',
          { deleted: query.deleted === true },
        ),
        TEST_ITEM_LIST.where(query),
      ),
      query,
      TEST_ITEM_LIST.sortSelect(query),
    );
    return TEST_ITEM_LIST.pick(
      { ...page, items: await this.presenter.many(user, page.items) },
      query,
    );
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record itself.
  @ApiOperation({
    summary: 'One test item',
    description:
      'With an ETag: If-None-Match gets 304 while unchanged; If-Match on a write refuses it if it changed.',
  })
  @ApiHeader(ifNoneMatchHeader())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  async get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.testItems.findOne(id);
    await this.authorization.authorize(TestItemPolicy, 'read', user, row);
    return this.presenter.one(user, row);
  }

  @Patch(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record and on each field.
  @ApiOperation({
    summary: 'Change a test item: only what is sent changes',
    description:
      'With If-Match, refused (412) if it changed since you read it. Audited with what changed.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SCHEMAS.update }) dto: UpdateTestItemDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    const row = await this.testItems.findOne(id);
    await this.authorization.authorize(TestItemPolicy, 'update', user, row);
    assertUnchanged(ifMatch, await this.presenter.one(user, row));
    await this.assertFields(user, 'update', dto, row);
    return this.presenter.one(
      user,
      await this.testItems.update(user, row, dto, ip),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone() // Checked below, on the record itself.
  @ApiOperation(deleteDocs(TEST_ITEM))
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    const row = await this.testItems.findOne(id);
    await this.authorization.authorize(TestItemPolicy, 'delete', user, row);
    assertUnchanged(ifMatch, await this.presenter.one(user, row));
    await this.testItems.delete(user, row, ip);
  }

  /** Field-level: a 403 naming the fields this caller may not set. */
  private async assertFields(
    user: RequestPrincipal,
    action: string,
    dto: object,
    row?: TestItem,
  ) {
    const forbidden = await this.access.forbiddenFields(
      user,
      action,
      'TestItem',
      dto as Record<string, unknown>,
      row,
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not set: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }
}
