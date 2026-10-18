import {
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
} from '@nestjs/swagger';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { assertUnchanged, Etag, ifMatchHeader } from '../../core/http/etag.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
  type RouteDocs,
} from '../records/record-routes.js';
import { REVISION_LIST } from './revision.list.js';
import { revisionDiffSchema, revisionSchema } from './revision.schemas.js';
import { RevisionsService } from './revisions.service.js';

export interface RevisionRouteOptions {
  /** What a restore answers: the record, as the feature's GET shows it. */
  restored: StandardSchemaV1;
  /** The feature's words for which fields a revision holds and a restore sets. */
  docs?: { list?: RouteDocs; restore?: RouteDocs };
}

/** A revision number in the path: a positive integer, else 400. */
const revisionNumber = new ParseIntPipe({ errorHttpStatusCode: 400 });

/**
 * `/<path>/{id}/revisions`: a record's revisions. Whoever may read the
 * record reads them, whoever may change it restores one (RevisionsService
 * asks the feature's RevisionTarget).
 */
export function revisionRoutes(
  spec: RecordRouteSpec,
  options: RevisionRouteOptions,
): Type {
  const { subject, noun } = spec;
  const a = aNounOf(spec);
  const record = (recordId: string) => ({ subject, recordId });

  @ApiNotFoundResponse({
    description: `No such ${noun} (or you may not read it), or no such revision.`,
  })
  @RecordController(spec, `${spec.path}/:id/revisions`)
  class RevisionRoutes {
    constructor(private readonly revisions: RevisionsService) {}

    @Get()
    @Can.Anyone() // Checked by RevisionsService: reading the record.
    @ApiOperation({
      summary:
        options.docs?.list?.summary ??
        `${a.replace(/^a/, 'A')}'s revisions, newest first`,
      description:
        options.docs?.list?.description ??
        `Revision 1 is the ${noun} as written; each change adds one, with what changed (\`changes\`, from → to). Cursor pages; \`?changedBy=user:<id>\`, \`?number.gte=\`.`,
    })
    @ApiOkResponse({ standardSchema: pageSchema(revisionSchema) })
    async list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      // Validated and documented by the list's schema, as attachments' (its types: `limit` a number).
      @Query({ schema: REVISION_LIST.schema }) query: ListQuery,
    ) {
      return REVISION_LIST.pick(
        await this.revisions.list(user, record(id), query),
        query,
      );
    }

    @Get(':number')
    @Can.Anyone()
    @ApiOperation({ summary: `One revision of ${a}` })
    @ApiOkResponse({ standardSchema: revisionSchema })
    async get(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('number', revisionNumber) number: number,
    ) {
      return this.revisions.get(user, record(id), number);
    }

    @Get(':a/diff/:b')
    @Can.Anyone()
    @ApiOperation({
      summary: `What differs between two revisions of ${a}`,
      description:
        "From revision `a`'s values to `b`'s (either order); `custom.<key>` per custom value.",
    })
    @ApiOkResponse({ standardSchema: revisionDiffSchema })
    async diff(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('a', revisionNumber) from: number,
      @Param('b', revisionNumber) to: number,
    ) {
      return this.revisions.diff(user, record(id), from, to);
    }

    @Post(':number/restore')
    @HttpCode(HttpStatus.OK)
    @Etag()
    @Can.Anyone() // Checked by RevisionsService: changing the record.
    @ApiOperation({
      summary: options.docs?.restore?.summary ?? `Set ${a} back to a revision`,
      description:
        options.docs?.restore?.description ??
        `Its values become the revision's, as a PATCH would set them (the same permissions, field-level ones too): audited \`${noun}.updated\`, and a new revision with \`restoredFrom\`. With If-Match (the ${noun}'s ETag), refused (412) if the ${noun} changed since you read it. Answers the ${noun}.`,
    })
    @ApiHeader(ifMatchHeader())
    @ApiOkResponse({ standardSchema: options.restored })
    @ApiForbiddenResponse({
      description: `You may not change the ${noun}, or a field it would set (field_forbidden).`,
    })
    @ApiPreconditionFailedResponse({
      description: `The ${noun} changed since you read it (precondition_failed).`,
    })
    async restore(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('number', revisionNumber) number: number,
      @Headers('if-match') ifMatch: string | undefined,
      @Ip() ip: string,
    ) {
      return this.revisions.restore(user, record(id), number, {
        ip,
        unchanged: (current) => assertUnchanged(ifMatch, current),
      });
    }
  }
  return namedController(
    RevisionRoutes,
    `${spec.className}RevisionsController`,
  );
}
