import type { NodeRequest, NodeRouter } from '@nestjs/platform-node';
import { context } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';

/**
 * A request's route as counted and measured: the method and the matched
 * route pattern, never the URL (`GET /v1/notes/{id}`, not one entry per id).
 * Route patterns' `:id` are written as OpenAPI's `{id}`.
 */
export const routeKey = (method: string, pattern: string) =>
  `${method.toUpperCase()} ${pattern.replace(/:(\w+)/g, '{$1}')}`;

/** Where recordMatchedRoutes() leaves the pattern of the route a request matched. */
const MATCHED_ROUTE = Symbol('matchedRoute');

type RoutedRequest = NodeRequest & { [MATCHED_ROUTE]?: string };
type RouteHandler = (req: RoutedRequest, ...rest: unknown[]) => unknown;

/**
 * Has every route the router registers record its pattern on the requests
 * it handles, for matchedRouteKey(), and on the request's OpenTelemetry
 * server span (`http.route`, span name `GET /v1/notes/:id`). Custom: Express
 * set `req.route` and its instrumentation named the span; the native adapter
 * keeps the matched pattern to itself (its radix tree), and the middleware
 * reading it (metrics, logging) run before any handler sees the route.
 * Every route goes through `NodeRouter.route()`; the handler's own
 * properties (the metadata Nest copies onto it) are kept.
 */
export function recordMatchedRoutes(router: NodeRouter) {
  const route = router.route.bind(router) as (
    method: string | null,
    path: string,
    handler: RouteHandler,
  ) => NodeRouter;
  Object.assign(router, {
    route(method: string | null, path: string, handler: RouteHandler) {
      const recording = Object.assign(
        (req: RoutedRequest, ...rest: unknown[]) => {
          req[MATCHED_ROUTE] = path;
          // Set by the http instrumentation when OpenTelemetry runs.
          const rpc = getRPCMetadata(context.active());
          if (rpc?.type === RPCType.HTTP) {
            rpc.route = path;
          }
          return handler(req, ...rest);
        },
        handler,
      );
      return route(method, path, recording);
    },
  });
}

/** The request's route key, or undefined when no route matched (yet). */
export function matchedRouteKey(req: NodeRequest) {
  const pattern = (req as RoutedRequest)[MATCHED_ROUTE];
  return pattern === undefined ? undefined : routeKey(req.method!, pattern);
}
