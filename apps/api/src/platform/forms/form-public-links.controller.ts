import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { minutes, Throttle } from '@nestjs/throttler';
import { listSchema } from '../../core/http/pagination.js';
import { Captcha } from '../../iam/captcha/captcha.guard.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { RequireFlag } from '../settings/require-flag.js';
import { FORMS_ENABLED } from './form-settings.js';
import { FormPolicy } from './form.policy.js';
import {
  type CreatePublicLinkDto,
  createdPublicLinkSchema,
  createPublicLinkSchema,
  formPublicLinkSchema,
  type OpenPublicFormDto,
  openPublicFormSchema,
  publicFormSchema,
  publicSubmissionSchema,
  type PublicSubmitDto,
  publicSubmitSchema,
} from './form.schemas.js';
import { FormPublicLinksService } from './form-public-links.service.js';

/**
 * A form's public links (docs/forms.md, "Public forms"): made, listed and
 * revoked by its editors (`Form.edit`), never by an API client.
 */
@ApiTags('forms')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@RequireFlag(FORMS_ENABLED)
@Controller('forms/:id/public-links')
export class FormPublicLinksController {
  constructor(private readonly links: FormPublicLinksService) {}

  @Get()
  @Can(FormPolicy, 'edit')
  @ApiOperation({ summary: "A form's public links, newest first" })
  @ApiOkResponse({ standardSchema: listSchema(formPublicLinkSchema) })
  @ApiNotFoundResponse()
  list(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.links.list(user, id);
  }

  @Post()
  @Can(FormPolicy, 'edit')
  @ApiOperation({
    summary: 'Publish a form to anyone holding a link',
    description:
      'A new link (at most 5 working at once), its token and URL shown this once. Anyone holding it fills in the published version without an account, until `expiresAt` (30 days by default, 365 at most), its revocation or its `maxSubmissions` (1000 by default). Members only: an API client gets 403. Audited (`form.link-created`).',
  })
  @ApiCreatedResponse({ standardSchema: createdPublicLinkSchema })
  @ApiBadRequestResponse({
    description:
      'A bad `expiresAt`, 5 working links already, or a published version with an option source (form_link_sources).',
  })
  @ApiNotFoundResponse()
  create(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: createPublicLinkSchema }) dto: CreatePublicLinkDto,
    @Ip() ip: string,
  ) {
    return this.links.create(user, id, dto, ip);
  }

  @Post(':linkId/revoke')
  @HttpCode(HttpStatus.OK)
  @Can(FormPolicy, 'edit')
  @ApiOperation({
    summary: 'Revoke a public link',
    description:
      'It stops working at once, for good. Audited (`form.link-revoked`).',
  })
  @ApiOkResponse({ standardSchema: formPublicLinkSchema })
  @ApiNotFoundResponse({ description: 'No working link of this form.' })
  revoke(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Ip() ip: string,
  ) {
    return this.links.revoke(user, id, linkId, ip);
  }
}

/**
 * Filling in a public form (docs/forms.md, "Public forms"): no sign-in, the
 * link's token is the proof, sent in the body (never in a URL: logs,
 * proxies, `Referer`), as the web page reads it from the link's fragment.
 * Every refusal of a link is the same 404; each route is throttled per
 * address, and sending is guarded by the bot protection (docs/auth.md).
 */
@ApiTags('forms')
@Public()
@Controller('public/forms')
export class PublicFormsController {
  constructor(private readonly links: FormPublicLinksService) {}

  @Post('open')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @ApiOperation({
    summary: 'Open a public form',
    description:
      'No sign-in. The published version its link opens: its name, description and definition, nothing of its tenant.',
  })
  @ApiOkResponse({ standardSchema: publicFormSchema })
  @ApiNotFoundResponse({
    description:
      'The link is invalid, expired, revoked or used up, or its form is not open (`form_link_not_found`).',
  })
  open(@Body({ schema: openPublicFormSchema }) dto: OpenPublicFormDto) {
    return this.links.open(dto.token);
  }

  @Post('submit')
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  @Captcha({ action: 'public-form', count: 'requests' })
  @ApiOperation({
    summary: 'Send a public form',
    description:
      'No sign-in: the answers to the version the link opened, checked as any submission is (400 with each problem at `answers.<key>`; 409 form_version_outdated when another was published since). Takes one of the link’s `maxSubmissions`. 10 per address in 10 minutes.',
  })
  @ApiCreatedResponse({ standardSchema: publicSubmissionSchema })
  @ApiBadRequestResponse({ description: 'The answers break the form’s rules.' })
  @ApiNotFoundResponse({
    description: 'The link does not work (`form_link_not_found`).',
  })
  submit(
    @Body({ schema: publicSubmitSchema }) dto: PublicSubmitDto,
    @Ip() ip: string,
  ) {
    return this.links.submit(dto, ip);
  }
}
