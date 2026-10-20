import { http, HttpResponse } from 'msw/http';
import { problem } from '@/test/server';
import { TEST_RECORD } from '@/test/panels-api';

// Watching, in memory: `GET /v1/subscriptions` (filters, cursor pages),
// `DELETE /v1/subscriptions/{subject}/{recordId}` and the record's own
// `POST`/`DELETE …/{id}/watch`. The record route is the test-only subject's
// unless `record` names a feature's.

export type TestSubscription = {
  subject: string;
  recordId: string;
  createdAt?: string;
};

export function subscriptionsHandlers(
  options: {
    record?: { subject: string; path: `${string}/{id}` };
    watched?: TestSubscription[];
    /** Rows a page of `GET /v1/subscriptions` holds when the caller gives no `limit`. */
    pageSize?: number;
  } = {},
) {
  const { subject, path } = options.record ?? TEST_RECORD;
  const route = path.replace('{id}', ':id');
  const watched = (options.watched ?? []).map((s) => ({
    createdAt: '2026-10-17T09:00:00.000Z',
    ...s,
  }));
  const calls = {
    /** The query string of each `GET /v1/subscriptions`. */
    listed: [] as string[],
    watched: [] as string[],
    unwatched: [] as string[],
    /** `subject/recordId` of each stop from the list. */
    removed: [] as string[],
  };
  const same = (s: { subject: string; recordId: string }, id: string) =>
    s.subject === subject && s.recordId === id;

  const handlers = [
    http.get('/v1/subscriptions', ({ request }) => {
      const url = new URL(request.url);
      calls.listed.push(url.search);
      const q = url.searchParams;
      const rows = watched.filter(
        (s) =>
          (!q.get('subject') || s.subject === q.get('subject')) &&
          (!q.get('recordId') || s.recordId === q.get('recordId')),
      );
      const limit = Number(q.get('limit') ?? options.pageSize ?? 50);
      const start = Number(q.get('cursor') ?? 0);
      const end = start + limit;
      return HttpResponse.json({
        items: rows.slice(start, end),
        nextCursor: end < rows.length ? String(end) : null,
      });
    }),
    http.delete('/v1/subscriptions/:subject/:recordId', ({ params }) => {
      const at = watched.findIndex(
        (s) => s.subject === params.subject && s.recordId === params.recordId,
      );
      calls.removed.push(
        `${String(params.subject)}/${String(params.recordId)}`,
      );
      if (at < 0) return problem(404, 'not_found');
      watched.splice(at, 1);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${route}/watch`, ({ params }) => {
      const id = params.id as string;
      calls.watched.push(id);
      if (!watched.some((s) => same(s, id))) {
        watched.push({
          subject,
          recordId: id,
          createdAt: '2026-10-18T09:00:00.000Z',
        });
      }
      return HttpResponse.json({ watching: true });
    }),
    http.delete(`${route}/watch`, ({ params }) => {
      const id = params.id as string;
      calls.unwatched.push(id);
      const at = watched.findIndex((s) => same(s, id));
      if (at < 0) return problem(404, 'not_found');
      watched.splice(at, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
  return { calls, handlers, watched };
}
