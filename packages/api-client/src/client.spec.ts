import { describe, expect, it } from 'vitest';
import { createApiClient, etagOf, notModified, unwrap } from './client.js';
import { filterParam } from './filter.js';
import { ApiError, parseProblem } from './problem.js';

/** A fetch that records each request and answers with `answer(request)`. */
function fakeFetch(answer: (request: Request) => Response) {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return answer(request);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const json = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

const BASE = 'https://api.example.com';

describe('problem details', () => {
  it('flattens a problem into an ApiError', async () => {
    const error = await ApiError.fromResponse(
      json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The request is invalid.',
          code: 'validation_failed',
          errors: [{ path: 'title', message: 'Required' }, { nonsense: 1 }],
          requestId: 'req-1',
        },
        { status: 400 },
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_failed',
      detail: 'The request is invalid.',
      errors: [{ path: 'title', message: 'Required' }],
      requestId: 'req-1',
      message: 'The request is invalid.',
    });
  });

  it('keeps extra fields, and copes with a body that is no problem', () => {
    expect(
      parseProblem(412, '{"code":"precondition_failed","etag":"\\"v2\\""}')
        .etag,
    ).toBe('"v2"');
    const html = parseProblem(502, '<html>Bad gateway</html>', 'from-header');
    expect(html).toEqual({
      status: 502,
      detail: '<html>Bad gateway</html>',
      requestId: 'from-header',
    });
    expect(new ApiError(parseProblem(503, '')).code).toBe('http_503');
  });
});

describe('createApiClient', () => {
  it('sends an API key or a token as a bearer, and the cookie with include', async () => {
    const { fetch, requests } = fakeFetch(() => json({ unread: 0 }));
    await createApiClient({
      baseUrl: BASE,
      fetch,
      credentials: { apiKey: 'sk_a_b' },
    }).GET('/v1/notifications/unread-count');
    let calls = 0;
    await createApiClient({
      baseUrl: BASE,
      fetch,
      credentials: { token: () => `jwt-${++calls}` },
    }).GET('/v1/notifications/unread-count');
    await createApiClient({ baseUrl: BASE, fetch, credentials: 'include' }).GET(
      '/v1/notifications/unread-count',
    );
    expect(
      requests.map((request) => request.headers.get('authorization')),
    ).toEqual(['Bearer sk_a_b', 'Bearer jwt-1', null]);
    expect(requests[2].credentials).toBe('include');
  });

  it('sends the languages it was given', async () => {
    const { fetch, requests } = fakeFetch(() => json({ unread: 0 }));
    await createApiClient({
      baseUrl: BASE,
      fetch,
      language: 'de',
      lang: 'ar',
    }).GET('/v1/notifications/unread-count');
    expect(requests[0].headers.get('accept-language')).toBe('de');
    expect(requests[0].headers.get('x-lang')).toBe('ar');
  });

  it('adds a fresh Idempotency-Key to every POST, and keeps one the caller set', async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ id: '1' }, { status: 201 }),
    );
    let n = 0;
    const api = createApiClient({
      baseUrl: BASE,
      fetch,
      idempotencyKey: () => `key-${++n}`,
    });
    const body = { title: 'Hello', body: 'World' };
    await api.POST('/v1/notes', { body });
    await api.POST('/v1/notes', { body });
    await api.POST('/v1/notes', {
      body,
      params: { header: { 'Idempotency-Key': 'mine' } },
    });
    await api.GET('/v1/notifications/unread-count');
    expect(
      requests.map((request) => request.headers.get('idempotency-key')),
    ).toEqual(['key-1', 'key-2', 'mine', null]);
  });

  it('throws the problem of an answer that is not 2xx', async () => {
    const { fetch } = fakeFetch(() =>
      json(
        { status: 404, code: 'not_found', detail: 'Note x not found.' },
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    const api = createApiClient({ baseUrl: BASE, fetch });
    const failure = api.GET('/v1/notes/{id}', {
      params: { path: { id: 'x' } },
    });
    await expect(failure).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('reads the ETag, and treats 304 as not modified rather than an error', async () => {
    const { fetch, requests } = fakeFetch((request) =>
      request.headers.get('if-none-match') === '"v1"'
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : json({ id: 'n1' }, { headers: { etag: '"v1"' } }),
    );
    const api = createApiClient({ baseUrl: BASE, fetch });
    const first = await api.GET('/v1/notes/{id}', {
      params: { path: { id: 'n1' } },
    });
    expect(etagOf(first)).toBe('"v1"');
    expect(notModified(first)).toBe(false);
    const again = await api.GET('/v1/notes/{id}', {
      params: {
        path: { id: 'n1' },
        header: { 'If-None-Match': etagOf(first) },
      },
    });
    expect(requests[1].headers.get('if-none-match')).toBe('"v1"');
    expect(notModified(again)).toBe(true);
    await expect(unwrap(Promise.resolve(again))).rejects.toMatchObject({
      code: 'not_modified',
    });
  });

  it('pages through a list by its nextCursor', async () => {
    const pages: Record<
      string,
      { items: { id: string }[]; nextCursor: string | null }
    > = {
      '': { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' },
      b: { items: [{ id: 'c' }], nextCursor: 'c' },
      c: { items: [], nextCursor: null },
    };
    const { fetch, requests } = fakeFetch((request) =>
      json(pages[new URL(request.url).searchParams.get('cursor') ?? '']),
    );
    const api = createApiClient({ baseUrl: BASE, fetch });
    const ids: string[] = [];
    for await (const note of api.items('/v1/notes', {
      limit: '2',
      filter: filterParam({ field: 'status', op: 'in', value: ['draft'] }),
    })) {
      ids.push(note.id);
    }
    expect(ids).toEqual(['a', 'b', 'c']);
    const urls = requests.map((request) => new URL(request.url));
    expect(urls.map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'b',
      'c',
    ]);
    expect(urls.every((url) => url.searchParams.get('limit') === '2')).toBe(
      true,
    );
    expect(JSON.parse(urls[0].searchParams.get('filter')!)).toEqual({
      field: 'status',
      op: 'in',
      value: ['draft'],
    });
  });
});
