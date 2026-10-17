import {
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  operationIdOf,
  RecordController,
  type RecordRouteSpec,
  type RouteDocs,
} from '../records/record-routes.js';
import { watchingSchema } from './subscription.schemas.js';
import { SubscriptionsService } from './subscriptions.service.js';

export interface WatchRouteOptions {
  /** The feature's words for who watches from the start. */
  docs?: { watch?: RouteDocs };
}

/**
 * `POST|DELETE /<path>/{id}/watch`: be told when a record changes. Whoever
 * the feature's SubscriptionTarget lets (SubscriptionsService.watch());
 * stopping needs nothing more than watching.
 */
export function watchRoutes(
  spec: RecordRouteSpec,
  options: WatchRouteOptions = {},
): Type {
  const { subject } = spec;
  const a = aNounOf(spec);

  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @RecordController(spec, spec.path)
  class WatchRoutes {
    constructor(private readonly subscriptions: SubscriptionsService) {}

    @Post(':id/watch')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone() // Checked by SubscriptionsService: the feature's SubscriptionTarget.
    @ApiOperation({
      summary:
        options.docs?.watch?.summary ?? `Watch ${a}: be told when it changes`,
      description:
        options.docs?.watch?.description ??
        `Stop with DELETE /v1/${spec.path}/{id}/watch (or /v1/subscriptions/${subject}/{id}).`,
      // Kept from when the route was the feature's own (operationIdOf()).
      operationId: operationIdOf(spec, 'watch'),
    })
    @ApiOkResponse({ standardSchema: watchingSchema })
    @ApiNotFoundResponse()
    async watch(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      await this.subscriptions.watch(user, { subject, recordId: id });
      return { watching: true };
    }

    @Delete(':id/watch')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone()
    @ApiOperation({
      summary: `Stop watching ${a}`,
      operationId: operationIdOf(spec, 'unwatch'),
    })
    @ApiNoContentResponse()
    @ApiNotFoundResponse({ description: 'You were not watching it.' })
    async unwatch(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      await this.subscriptions.remove(user, { subject, recordId: id });
    }
  }
  return namedController(WatchRoutes, `${spec.className}WatchController`);
}
