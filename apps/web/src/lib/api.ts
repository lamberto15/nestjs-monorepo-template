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
  // The body of a sent Request is spent: keep a copy to send again, and
  // whether its Idempotency-Key was the caller's.
  const copies = new Map<string, { request: Request; callerKey: boolean }>();
  return {
    onRequest({ request, id, params }) {
      const header = (params as { header?: Record<string, unknown> }).header;
      const callerKey = Object.keys(header ?? {}).some(
        (name) => name.toLowerCase() === 'idempotency-key',
      );
      copies.set(id, { request: request.clone(), callerKey });
      return undefined;
    },
    async onResponse({ response, id, options }) {
      const saved = copies.get(id);
      copies.delete(id);
      if (response.status !== 403 || !saved) {
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
      // The API refuses step-up in a guard, before its idempotency layer:
      // nothing was stored under the key, so the retry may reuse it. A key
      // the caller set (`params.header['Idempotency-Key']`) is theirs and is
      // kept; the one the client made up for this call is replaced, as the
      // retry is a new attempt of the client's own.
      const headers = new Headers(saved.request.headers);
      if (!saved.callerKey && headers.has('idempotency-key')) {
        headers.set('idempotency-key', crypto.randomUUID());
      }
      return options.fetch(new Request(saved.request, { headers }));
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
  get language() {
    return i18n.language;
  },
});
api.use(reauthenticationMiddleware());
