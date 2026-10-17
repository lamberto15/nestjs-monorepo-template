import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiTooManyRequestsResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { DataTransferService } from '../data-transfer/data-transfer.service.js';
import {
  acceptConsentSchema,
  accountStateSchema,
  consentSchema,
  deletionSchema,
  exportRequestSchema,
  requestDeletionSchema,
} from './account.schemas.js';
import { AccountLifecycleService } from './account.service.js';

/**
 * A person's rights over their own account: a copy of their data, its
 * deletion, and a record of what they agreed to. Users only, never while
 * impersonating.
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'Not signed in as a user.' })
@UserOnly()
@Can.Anyone()
@Controller('account')
export class AccountController {
  constructor(
    private readonly account: AccountLifecycleService,
    private readonly transfers: DataTransferService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Your account: a pending deletion, what you agreed to',
  })
  @ApiOkResponse({ standardSchema: accountStateSchema })
  state(@CurrentUser() user: UserPrincipal) {
    // The person's own, across their tenants: not an administrator's to read
    // while acting as them in one tenant (docs/tenancy.md).
    notWhileImpersonating(user);
    return this.account.state(user);
  }

  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'A copy of everything held about you',
    description:
      'Starts an export (one record per row: kind, id, data) and answers 202 with its id: follow it at GET /v1/data/transfers/{id}, which gives the download link when done.',
  })
  @ApiAcceptedResponse({ description: '{ id, status }' })
  export(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: exportRequestSchema })
    body: z.infer<typeof exportRequestSchema>,
  ) {
    notWhileImpersonating(user);
    return this.transfers.startExport(user, {
      name: 'account',
      format: body.format,
    });
  }

  // The password is checked here: limited like signing in, per address and per account.
  @Post('deletion')
  @RecentAuthentication()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @UserThrottle({ limit: 10, ttl: minutes(15) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask for your account to be deleted',
    description:
      'Carried out after the grace period (ACCOUNT_DELETION_GRACE_DAYS), unless cancelled before; you get an email saying when. Wants a recent sign-in (`reauthentication_required`: POST /auth/reauthenticate) and, when the account has one, your password again. Records you created stay, without your name.',
  })
  @ApiOkResponse({ standardSchema: deletionSchema })
  @ApiBadRequestResponse({
    description: 'The password is missing (validation_failed).',
  })
  @ApiForbiddenResponse({
    description:
      'The password is wrong; or `reauthentication_required`; or acting as another user.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'More than 5 attempts from this address, or 10 for this account, in 15 minutes.',
  })
  requestDeletion(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: requestDeletionSchema })
    body: z.infer<typeof requestDeletionSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.account.requestDeletion(user, body.password, ip);
  }

  @Delete('deletion')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Keep your account: cancel the pending deletion' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'No deletion is pending.' })
  async cancelDeletion(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    notWhileImpersonating(user);
    await this.account.cancelDeletion(user, ip);
  }

  @Get('consents')
  @ApiOperation({
    summary: 'What you agreed to: the latest version of each kind',
  })
  @ApiOkResponse({ standardSchema: listSchema(consentSchema) })
  async consents(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    return { items: await this.account.consents(user.id) };
  }

  @Post('consents')
  @ApiOperation({
    summary: 'Record that you accept a version of the terms, a policy…',
    description:
      'The app names the kinds (`terms`, `privacy`, `marketing`) and versions. Accepting the same version again moves the time. Audited.',
  })
  @ApiCreatedResponse({ standardSchema: consentSchema })
  accept(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: acceptConsentSchema })
    body: z.infer<typeof acceptConsentSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.account.accept(user, body.kind, body.version, ip);
  }
}
