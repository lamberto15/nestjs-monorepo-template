import {
  createApiClient,
  type ApiClient,
} from '@nestjs-monorepo-template/api-client';
import { i18n } from '@/i18n';
import { requestReauthentication, type ReauthProblem } from '@/lib/reauth';

type Middleware = Parameters<ApiClient['use']>[0];

/**
 * Step-up (docs/auth.md, "Step-up"): a sensitive route answers 403
 * `reauthentication_required` when the sign-in is older than the window. The
 * user confirms it's them in the dialog, then the same request is sent again,
 * so no caller handles it. openapi-fetch has no retry of its own; its
 * middleware may return another Response (runs before the conventions
 * middleware, which turns a non-2xx answer into an ApiError).
 */
export function reauthenticationMiddleware(
  ask: (problem: ReauthProblem) => Promise<boolean> = requestReauthentication,
): Middleware {
  // The body of a sent Request is spent: keep a copy to send again.
  const copies = new Map<string, Request>();
  return {
    onRequest({ request, id }) {
      copies.set(id, request.clone());
      return undefined;
    },
    async onResponse({ response, id, options }) {
      const copy = copies.get(id);
      copies.delete(id);
      if (response.status !== 403 || !copy) {
        return undefined;
      }
      const problem = (await response
        .clone()
        .json()
        .catch(() => null)) as ReauthProblem | null;
      if (problem?.code !== 'reauthentication_required') {
        return undefined;
      }
      if (!(await ask({ ...problem, status: 403 }))) {
        return undefined;
      }
      // The refused request did nothing: the retry is a new operation, with
      // a new Idempotency-Key (a key the server saw could replay the 403).
      const headers = new Headers(copy.headers);
      if (headers.has('idempotency-key')) {
        headers.set('idempotency-key', crypto.randomUUID());
      }
      return options.fetch(new Request(copy, { headers }));
    },
    onError({ id }) {
      copies.delete(id);
      return undefined;
    },
  };
}

// Same-origin (dev proxy, Caddy): the __Host-sid cookie rides on every call.
// The origin is spelled out because Request (Node's, in tests) needs an
// absolute URL. Accept-Language follows the UI language, read at each request.
export const api: ApiClient = createApiClient({
  baseUrl: globalThis.location?.origin ?? '',
  credentials: 'include',
  // Looked up at each call, not once at import: a fetch replaced later (the
  // tests' msw, an instrumented one) is the one used.
  fetch: (input, init) => globalThis.fetch(input, init),
  get language() {
    return i18n.language;
  },
});
api.use(reauthenticationMiddleware());
