import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import { ListPolicy } from './list.policy.js';
import { listMetadataSchema } from './list-metadata.schemas.js';
import { ListsService } from './lists.service.js';

/**
 * Each subject's list, described at runtime: what a generic table builds its
 * filter menus, sort and columns from, the same declaration the list route
 * validates with (docs/api-conventions.md, "List metadata").
 */
@ApiTags('lists')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('lists')
export class ListsController {
  constructor(
    private readonly lists: ListsService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Get(':subject')
  @Can.Anyone() // Checked below, on the subject.
  @ApiOperation({
    summary: "A subject's list: its filters, operators, sorts and fields",
    description:
      "The fields the list may be filtered and sorted by, with their operators, the custom fields your tenant has now, `fields=` names, search and the list's limits. A field your permissions hide is left out. For anyone who may read the subject.",
  })
  @ApiParam({
    name: 'subject',
    schema: { type: 'string', example: 'Note' },
    description: 'The kind of record, as permissions name it (`Note`).',
  })
  @ApiOkResponse({ standardSchema: listMetadataSchema })
  @ApiForbiddenResponse({ description: 'You may not read the subject.' })
  @ApiNotFoundResponse({ description: 'No list of that subject (not_found).' })
  async describe(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
  ) {
    // An unknown subject is a 404 before any permission is asked.
    this.lists.source(subject);
    await this.authorization.authorize(ListPolicy, 'read', user, subject);
    return this.lists.describe(user, subject);
  }
}
