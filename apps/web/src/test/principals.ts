import { http, HttpResponse } from 'msw/http';
import type { Principal } from '@/lib/principals';
import { problem } from '@/test/server';

/** A user as `GET /v1/access/principals` lists them. */
export function userPrincipal(user: {
  id: string;
  email: string;
  name: string;
  active?: boolean;
}): Principal {
  return {
    id: user.id,
    key: `user:${user.id}`,
    kind: 'user',
    label: user.name,
    email: user.email,
    active: user.active ?? true,
  };
}

/** An API client as `GET /v1/access/principals` lists them. */
export function clientPrincipal(client: {
  id: string;
  name: string;
  active?: boolean;
}): Principal {
  return {
    id: client.id,
    key: `client:${client.id}`,
    kind: 'client',
    label: client.name,
    email: null,
    active: client.active ?? true,
  };
}

/**
 * `GET /v1/access/principals` over these principals, as the API answers it:
 * `q` a part of the label or address (any case), `kind`, `active=true`; one
 * page. `'forbidden'`: a caller who may not list people (403). `seen` gets
 * every query asked.
 */
export function principalsHandler(
  principals: readonly Principal[] | 'forbidden',
  seen?: URLSearchParams[],
) {
  return http.get('/v1/access/principals', ({ request }) => {
    const query = new URL(request.url).searchParams;
    seen?.push(query);
    if (principals === 'forbidden') {
      return problem(403, 'forbidden');
    }
    const q = query.get('q')?.toLowerCase();
    const kind = query.get('kind');
    const items = principals.filter(
      (p) =>
        (!q ||
          p.label.toLowerCase().includes(q) ||
          !!p.email?.toLowerCase().includes(q)) &&
        (!kind || p.kind === kind) &&
        (query.get('active') !== 'true' || p.active),
    );
    return HttpResponse.json({ items, nextCursor: null });
  });
}
