import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type DismissInboxDto,
  dismissInboxSchema,
  inboxPageSchema,
  type InboxQuery,
  inboxQuerySchema,
} from './inbox.schemas.js';
import { InboxService } from './inbox.service.js';

/** The caller's work inbox: what waits on them, from every source. */
@ApiTags('inbox')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each source returns only what this caller may see and has to do.
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOperation({
    summary: 'Your work inbox',
    description:
      'What waits on you in the current tenant, newest first, cursor pages: approval requests to decide (`approval.decide`, yours or of someone you stand in for) or to revise (`approval.revise`, changes requested on your request), and unread mentions (`mention`). Each item is read from its source now, so it is gone once the work is done, and only what you may see is listed. `?source=` narrows to one source.',
  })
  @ApiOkResponse({ standardSchema: inboxPageSchema })
  @ApiBadRequestResponse({ description: 'A bad cursor (validation_failed).' })
  @ApiNotFoundResponse({ description: 'No such source.' })
  list(
    @CurrentUser() user: Principal,
    @Query({ schema: inboxQuerySchema }) query: InboxQuery,
  ) {
    return this.inbox.page(user, query);
  }

  @Post('dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dismiss an item',
    description:
      'Only for items with `canDismiss` (a mention is marked read). An approval is done by deciding it.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'The item is done at its source.' })
  @ApiNotFoundResponse({ description: 'Not an item of yours.' })
  async dismiss(
    @CurrentUser() user: Principal,
    @Body({ schema: dismissInboxSchema }) dto: DismissInboxDto,
  ) {
    await this.inbox.dismiss(user, dto.key);
  }
}
