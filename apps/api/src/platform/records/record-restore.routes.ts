import {
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { Etag } from '../../core/http/etag.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import {
  RECORD_CONTRACT,
  type RecordContract,
  RecordPresenter,
} from './record-contract.js';
import {
  aNounOf,
  namedController,
  operationIdOf,
  RecordController,
} from './record-routes.js';
import type { RecordPolicy } from './record-policy.js';
import type { RecordSchemas } from './record.schemas.js';

/**
 * `POST /<path>/{id}/restore`: a record out of the recycle bin, until the
 * purge. Registered by recordParts() when the declaration says `softDelete`;
 * the feature's service restores it (its audit entry), its policy decides
 * who may (`restore`).
 */
export function restoreRoutes(
  declaration: RecordDeclaration,
  options: { policy: Type<RecordPolicy>; schemas: RecordSchemas },
): Type {
  const a = aNounOf(declaration);

  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @RecordController(declaration, declaration.path)
  class RestoreRoutes {
    constructor(
      @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
      private readonly authorization: AuthorizationService,
      private readonly presenter: RecordPresenter,
    ) {}

    @Post(':id/restore')
    @HttpCode(HttpStatus.OK)
    // The ETag GET /{id} would send for the restored record.
    @Etag()
    @Can.Anyone() // Checked below, on the record itself.
    @ApiOperation({
      summary: `Restore ${a} from the recycle bin`,
      description:
        'Until the purge (SOFT_DELETE_RETENTION_DAYS after deleting it).',
      // Kept from when the route was the feature's own (operationIdOf()).
      operationId: operationIdOf(declaration, 'restore'),
    })
    @ApiOkResponse({ standardSchema: options.schemas.response })
    @ApiNotFoundResponse({ description: 'Not in the recycle bin (or purged).' })
    async restore(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Ip() ip: string,
    ) {
      const row = await this.c.service.findOne(id, undefined, {
        deleted: true,
      });
      await this.authorization.authorize(options.policy, 'restore', user, row);
      return this.presenter.one(
        user,
        await this.c.service.restore!(user, row, ip),
      );
    }
  }
  return namedController(
    RestoreRoutes,
    `${declaration.className}RestoreController`,
  );
}

/** The delete route's text (the feature's controller): to the recycle bin, or for good. */
export const deleteDocs = (declaration: RecordDeclaration) =>
  declaration.softDelete
    ? {
        summary: `Delete ${aNounOf(declaration)} (to the recycle bin)`,
        description: `POST /v1/${declaration.path}/{id}/restore brings it back until it is purged.`,
      }
    : { summary: `Delete ${aNounOf(declaration)}` };
