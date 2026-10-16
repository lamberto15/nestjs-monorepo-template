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
  Post,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { MAIL_SUPPRESSION_LIST } from './suppression.list.js';
import { MailSuppressionPolicy } from './suppression.policy.js';
import {
  type CreateMailSuppressionDto,
  createMailSuppressionSchema,
  mailSuppressionSchema,
} from './suppression.schemas.js';
import { SuppressionsService } from './suppressions.service.js';

/**
 * The suppression list: the addresses mail is not sent to, why, and since
 * when (docs/deliverability.md). Reading takes MailSuppression.view,
 * adding and removing MailSuppression.manage; users only.
 */
@ApiTags('mail')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or token.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('mail/suppressions')
export class SuppressionsController {
  constructor(private readonly suppressions: SuppressionsService) {}

  @Get()
  @Can(MailSuppressionPolicy, 'view')
  @ApiOperation({
    summary: 'The suppression list, newest first',
    description:
      'Addresses mail is not sent to (`suppressedAt` set) and addresses being watched for soft bounces (`suppressedAt.isNull=true`). `?address=ada@example.com` (any case), `?address.endsWith=@example.com`, `?reason=complaint`, `?source=ses`; `?sort=-lastSeenAt`. Cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(mailSuppressionSchema) })
  async list(
    @Query({ schema: MAIL_SUPPRESSION_LIST.schema }) query: ListQuery,
  ) {
    return MAIL_SUPPRESSION_LIST.pick(
      await this.suppressions.list(query),
      query,
    );
  }

  @Get(':id')
  @Can(MailSuppressionPolicy, 'view')
  @ApiOperation({ summary: 'One entry' })
  @ApiOkResponse({ standardSchema: mailSuppressionSchema })
  @ApiNotFoundResponse()
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppressions.findOne(id);
  }

  @Post()
  @Idempotent()
  @Can(MailSuppressionPolicy, 'manage')
  @ApiOperation({
    summary: 'Stop mail to an address',
    description:
      'A manual entry (`reason: manual`): nothing is sent to the address, essential mail included, until it is removed. Audited (`mailSuppression.created`).',
  })
  @ApiCreatedResponse({ standardSchema: mailSuppressionSchema })
  @ApiBadRequestResponse({ description: 'Not an email address.' })
  @ApiConflictResponse({ description: 'The address is listed already.' })
  create(
    @CurrentUser() user: Principal,
    @Body({ schema: createMailSuppressionSchema })
    dto: CreateMailSuppressionDto,
    @Ip() ip: string,
  ) {
    return this.suppressions.create(user, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(MailSuppressionPolicy, 'manage')
  @ApiOperation({
    summary: 'Send mail to the address again',
    description:
      'Removes the entry. For a bounced address, once the mailbox is known to work; for a complaint, only when the person asked for mail again. A new bounce or complaint lists it again. Audited (`mailSuppression.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.suppressions.remove(user, id, ip);
  }
}
