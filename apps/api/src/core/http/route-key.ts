import type { Request } from 'express';

/**
 * A request's route as counted and measured: the method and the matched
 * route pattern, never the URL (`GET /v1/notes/{id}`, not one entry per id).
 * Express patterns' `:id` are written as OpenAPI's `{id}`.
 */
export const routeKey = (method: string, pattern: string) =>
  `${method.toUpperCase()} ${pattern.replace(/:(\w+)/g, '{$1}')}`;

/** The request's route key, or undefined when no route matched (yet). */
export function matchedRouteKey(req: Request) {
  return req.route
    ? routeKey(req.method, `${req.baseUrl}${String(req.route.path)}`)
    : undefined;
}
