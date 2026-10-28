import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type ChoiceOptionsQuery,
  choiceOptionsQuerySchema,
  choiceOptionsSchema,
  choiceSetSchema,
  choiceSetsSchema,
  type ValidateChoicesDto,
  validateChoicesSchema,
} from './choices.schemas.js';
import { ChoicesService } from './choices.service.js';

/**
 * Dependent dropdowns: choices from server-registered providers, for the
 * fields of a set that depend on one another (customer, then its
 * projects). Anyone signed in; each provider says who may use it and
 * returns only what they may see.
 */
@ApiTags('choices')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each provider decides who may use it and what they see.
@Controller('choices')
export class ChoicesController {
  constructor(private readonly choices: ChoicesService) {}

  @Get()
  @ApiOperation({
    summary: 'The sets of dependent choices',
    description:
      'Each set’s fields (parents first) that you may use, and what each depends on.',
  })
  @ApiOkResponse({ standardSchema: choiceSetsSchema })
  list(@CurrentUser() user: RequestPrincipal) {
    return this.choices.sets(user);
  }

  @Get(':set')
  @ApiOperation({ summary: 'One set of dependent choices' })
  @ApiOkResponse({ standardSchema: choiceSetSchema })
  @ApiNotFoundResponse()
  one(@CurrentUser() user: RequestPrincipal, @Param('set') set: string) {
    return this.choices.set(user, set);
  }

  @Get(':set/:field/options')
  @ApiOperation({
    summary: 'The choices of a field, for its parents’ values',
    description:
      'At most `limit` (50) matching `q`, for the values of the fields it depends on (`parent.<field>=<value>`, all required). The answer echoes `parents`: ignore it when the form’s parents have changed since. Only what you may see.',
  })
  @ApiOkResponse({ standardSchema: choiceOptionsSchema })
  @ApiBadRequestResponse({
    description:
      'A parent value is missing, malformed, or not a parameter of the field (validation_failed, `parent.<field>`).',
  })
  @ApiForbiddenResponse({ description: 'You may not use its provider.' })
  @ApiNotFoundResponse()
  options(
    @CurrentUser() user: RequestPrincipal,
    @Param('set') set: string,
    @Param('field') field: string,
    @Query({ schema: choiceOptionsQuerySchema }) query: ChoiceOptionsQuery,
  ) {
    return this.choices.options(user, set, field, query);
  }

  @Post(':set/validate')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Check a set’s values',
    description:
      'Each value must be one of the choices you could pick for the values of its parents sent with it (the check a write repeats). A parent changed under a child that no longer fits is refused for the child. Nothing is stored.',
  })
  @ApiNoContentResponse({ description: 'Every value is a valid choice.' })
  @ApiBadRequestResponse({
    description:
      'A value is not an available choice, or its parent is missing or invalid (validation_failed, `path` the field).',
  })
  @ApiForbiddenResponse({ description: 'You may not use a field’s provider.' })
  @ApiNotFoundResponse()
  async validate(
    @CurrentUser() user: RequestPrincipal,
    @Param('set') set: string,
    @Body({ schema: validateChoicesSchema }) dto: ValidateChoicesDto,
  ) {
    await this.choices.assertValid(user, set, dto.values);
  }
}
