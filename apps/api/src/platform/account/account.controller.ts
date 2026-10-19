import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  Public,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import {
  startedSchema,
  statusSchema,
} from '../data-transfer/data-transfer.schemas.js';
import { DataTransferService } from '../data-transfer/data-transfer.service.js';
import {
  acceptConsentSchema,
  accountExportsQuerySchema,
  accountStateSchema,
  cancelDeletionByLinkSchema,
  consentKindSchema,
  consentSchema,
  deletionSchema,
  exportRequestSchema,
  requestDeletionSchema,
} from './account.schemas.js';
import { AccountLifecycleService } from './account.service.js';
import { ConsentKinds } from './consent-kinds.js';

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
      'Starts an export (one record per row: kind, id, data) and answers 202 with its id: follow it at GET /v1/data/transfers/{id}, which gives the download link when done; GET /v1/account/exports lists them.',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
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

  @Get('exports')
  @ApiOperation({
    summary: 'The copies of your data you asked for',
    description:
      'Your account exports (POST /v1/account/export), newest first, by cursor (`limit`, `cursor` = the previous `nextCursor`), each as GET /v1/data/transfers/{id} tells it: a completed one with its download link (valid 30 minutes from this answer; ask again for a new one). Kept 7 days after they end (`expiresAt`), then gone: ask for a new export. Yours alone, in any tenant or none; never while acting as another user.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(statusSchema) })
  @ApiForbiddenResponse({ description: 'Acting as another user.' })
  exports(
    @CurrentUser() user: UserPrincipal,
    @Query({ schema: accountExportsQuerySchema })
    query: z.infer<typeof accountExportsQuerySchema>,
  ) {
    notWhileImpersonating(user);
    return this.transfers.listAccountExports(user, query);
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
      'Carried out after the grace period (ACCOUNT_DELETION_GRACE_DAYS), unless cancelled before; you get an email saying when, with a link that cancels without signing in. Wants a recent sign-in (`reauthentication_required`: POST /auth/reauthenticate) and, when the account has one (`hasPassword` of GET /v1/auth/me), your password again. Every other session and every token client is signed out; this one stays, to cancel (signing in again works too, until the deletion is carried out). Asked again while one is pending: that one, unchanged, no new mail. Records you created stay, without your name.',
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
    @CurrentSession() session: SessionRecord | undefined,
    @Body({ schema: requestDeletionSchema })
    body: z.infer<typeof requestDeletionSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.account.requestDeletion(user, body.password, ip, session?.id);
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
    description:
      "Each kind you accepted, with its latest version and `withdrawnAt` (null: in force). A version other than the kind's current one (GET /v1/account/consent-kinds) is to be asked for again.",
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
      'A kind GET /v1/account/consent-kinds lists, at its current `version`. Every acceptance is kept (accepting again adds one; after a withdrawal it gives the consent again). Audited (`account.consented`).',
  })
  @ApiCreatedResponse({ standardSchema: consentSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown kind, or a version other than the current one (validation_failed, naming `kind` or `version`).',
  })
  accept(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: acceptConsentSchema })
    body: z.infer<typeof acceptConsentSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.account.accept(user, body.kind, body.version, ip);
  }

  @Delete('consents/:kind')
  @ApiOperation({
    summary: 'Withdraw a consent (marketing…)',
    description:
      'As easy as giving it: no password, no recent sign-in. The acceptances stay, as proof, stamped with the withdrawal (`withdrawnAt`); POST /v1/account/consents gives it again. Audited (`account.consent-withdrawn`). A required kind (the terms, the privacy policy) cannot be withdrawn: deleting the account ends it.',
  })
  @ApiOkResponse({ standardSchema: consentSchema })
  @ApiNotFoundResponse({
    description: 'Not given, or withdrawn already.',
  })
  @ApiConflictResponse({
    description:
      '`consent_required`: a required kind; delete the account instead (POST /v1/account/deletion).',
  })
  withdraw(
    @CurrentUser() user: UserPrincipal,
    @Param('kind') kind: string,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.account.withdraw(user, kind, ip);
  }
}

/**
 * The kinds of consent the app asks for (PlatformModule.forRoot({
 * consents })), with their current version and texts: for the privacy
 * page, and for a sign-up page before there is an account, so public.
 * They hold nothing about anyone.
 */
@ApiTags('account')
@Public()
@Controller('account/consent-kinds')
export class ConsentKindsController {
  constructor(private readonly kinds: ConsentKinds) {}

  @Get()
  @ApiOperation({
    summary: 'The kinds of consent asked for here, and their current version',
    description:
      "Declared by the app (`CONSENT_KINDS`, platform/account/consent-kinds.ts). `required`: needed to use the service (accept it, it cannot be withdrawn); otherwise optional. Labels and descriptions in the request's language. No sign-in needed.",
  })
  @ApiOkResponse({ standardSchema: listSchema(consentKindSchema) })
  list() {
    return { items: this.kinds.list() };
  }
}

/**
 * The deletion mail's cancel link, without a sign-in: the person may have
 * lost their password, or never asked for the deletion and wants it
 * stopped at once. The web app's page (WEB_URL/cancel-deletion?token=…)
 * POSTs the token here; a GET would let a mail scanner that follows links
 * cancel it. Public, limited per address, and every refusal is the same
 * 400, whether the token is forged, expired, used, or the account exists
 * at all.
 */
@ApiTags('account')
@Public()
@Controller('account/deletion')
export class AccountDeletionLinkController {
  constructor(private readonly account: AccountLifecycleService) {}

  @Post('cancel')
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Keep your account: cancel the deletion with the mail's link",
    description:
      'No sign-in: the token of the link in the deletion mail. It works once, for the request it was sent for, until the deletion is carried out. Audited (`account.deletion-cancelled`, `via: link`).',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      'The link is invalid, expired or used, or the deletion was cancelled or carried out already: one answer for all.',
  })
  @ApiTooManyRequestsResponse({
    description: 'More than 10 attempts from this address in 15 minutes.',
  })
  async cancel(
    @Body({ schema: cancelDeletionByLinkSchema })
    body: z.infer<typeof cancelDeletionByLinkSchema>,
    @Ip() ip: string,
  ) {
    await this.account.cancelDeletionByLink(body.token, ip);
  }
}
