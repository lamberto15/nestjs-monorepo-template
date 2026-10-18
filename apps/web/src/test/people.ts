import { http, HttpResponse } from 'msw/http';

/**
 * `GET /v1/people` over these people, as the API answers it: the active
 * members whose name contains `q` (any case), each one's key and name.
 * `seen` gets the `q` of every call ('' without one).
 */
export function peopleHandler(
  people: readonly { id: string; name: string }[],
  seen?: string[],
) {
  return http.get('/v1/people', ({ request }) => {
    const q = new URL(request.url).searchParams.get('q') ?? '';
    seen?.push(q);
    return HttpResponse.json({
      items: people
        .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
        .map((p) => ({ key: `user:${p.id}`, name: p.name })),
    });
  });
}
