import { http, HttpResponse } from 'msw/http';

/**
 * `GET /v1/people` over these people, as the API answers it: the active
 * members whose name contains `q` (any case), or, with `key=`, the names of
 * those keys (in the order asked; one nobody has is left out; 400 over 20
 * keys, or with `q` too), each one's key and name. `seen` gets the `q` of
 * every call ('' without one); `asked` gets every call's query string.
 */
export function peopleHandler(
  people: readonly { id: string; name: string; avatarUrl?: string | null }[],
  seen?: string[],
  asked?: URLSearchParams[],
) {
  return http.get('/v1/people', ({ request }) => {
    const query = new URL(request.url).searchParams;
    asked?.push(query);
    const q = query.get('q') ?? '';
    seen?.push(q);
    const key = query.get('key');
    const all = people.map((p) => ({
      key: `user:${p.id}`,
      name: p.name,
      avatarUrl: p.avatarUrl ?? null,
    }));
    if (key !== null) {
      const keys = key.split(',');
      if (keys.length > 20 || query.has('q')) {
        return HttpResponse.json(
          { status: 400, code: 'validation_failed', detail: 'Too many keys.' },
          {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }
      return HttpResponse.json({
        items: keys.flatMap((k) => all.filter((p) => p.key === k)),
      });
    }
    return HttpResponse.json({
      items: all.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())),
    });
  });
}

/**
 * `GET /v1/organizational-units` over these units, as the API answers it: `q` a part of the
 * name, `id=` these units (one nobody has is left out); one page. `asked`
 * gets every call's query string.
 */
export function unitsHandler(
  units: readonly { id: string; name: string }[],
  asked?: URLSearchParams[],
) {
  return http.get('/v1/organizational-units', ({ request }) => {
    const query = new URL(request.url).searchParams;
    asked?.push(query);
    const ids = query.get('id')?.split(',');
    const q = (query.get('q') ?? '').toLowerCase();
    return HttpResponse.json({
      items: units
        .filter(
          (t) =>
            (!ids || ids.includes(t.id)) && t.name.toLowerCase().includes(q),
        )
        .map((t) => ({ ...t, parentId: null, depth: 0 })),
      nextCursor: null,
    });
  });
}
