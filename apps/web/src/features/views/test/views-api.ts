import { http, HttpResponse } from 'msw/http';
import { problem, server } from '@/test/server';
import type { SavedView } from '../api';

// The saved-views API in memory (msw) on a test-only list (TestItem): the routes
// docs/saved-views.md lists, recording what the picker sent. A view named
// "Taken" is a 409 on save and rename, one named "Forbidden" a 403
// `field_forbidden`; a view with `stale` fails to apply with a 400.

export const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  subject: 'TestItem',
  name: 'Drafts',
  visibility: 'private',
  teamId: null,
  owner: 'user:1',
  mine: true,
  editable: true,
  query: { status: 'draft', sort: 'title' },
  columns: null,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const TEST_ITEMS = '/v1/test-items';

/** The list as the API describes it: filterable status, a search, a datetime. */
const description = {
  subject: 'TestItem',
  fields: [
    {
      name: 'title',
      type: 'string',
      operators: ['contains', 'eq'],
      sortable: true,
      custom: false,
    },
    {
      name: 'status',
      type: 'enum',
      options: ['draft', 'published'],
      operators: ['eq', 'in'],
      sortable: true,
      custom: false,
    },
    {
      name: 'createdAt',
      type: 'datetime',
      operators: ['lt', 'gte', 'between'],
      sortable: true,
      custom: false,
    },
  ],
  select: ['id', 'number', 'title', 'status', 'tags', 'createdAt'],
  search: true,
  recycleBin: false,
  defaultSort: '-createdAt',
  limits: { defaultLimit: 50, maxLimit: 100 },
};

export function useViewsApi(options: {
  views: (SavedView & { stale?: boolean; forbidden?: boolean })[];
}) {
  const views = new Map(options.views.map((v) => [v.id, { ...v }]));
  const calls = {
    reads: [] as string[],
    created: [] as Record<string, unknown>[],
    patched: [] as { id: string; body: Record<string, unknown> }[],
    deleted: [] as string[],
    applied: [] as string[],
    /** The query string of each list read. */
    lists: [] as string[],
  };
  server.use(
    http.get(TEST_ITEMS, ({ request }) => {
      calls.lists.push(new URL(request.url).search);
      return HttpResponse.json({
        items: [
          { id: 'i1', number: 'T-1', title: 'Q3 targets', status: 'draft' },
        ],
        nextCursor: null,
        page: 1,
        pageCount: 1,
        total: 1,
      });
    }),
    http.get('/v1/lists/:subject', () => HttpResponse.json(description)),
    http.get('/v1/teams', () =>
      HttpResponse.json({
        items: [{ id: 'team-1', name: 'Sales', parentId: null, depth: 0 }],
        nextCursor: null,
      }),
    ),
    http.get('/v1/views', ({ request }) => {
      calls.reads.push(new URL(request.url).search);
      return HttpResponse.json({
        items: [...views.values()],
        nextCursor: null,
      });
    }),
    http.post('/v1/views', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.created.push(body);
      if (body.name === 'Taken') return problem(409, 'conflict');
      if (body.name === 'Forbidden') return problem(403, 'field_forbidden');
      const created = view({
        ...(body as Partial<SavedView>),
        id: 'v-new',
      });
      views.set(created.id, created);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.get('/v1/views/:id/apply', ({ params }) => {
      const found = views.get(params.id as string);
      if (!found) return problem(404, 'not_found');
      calls.applied.push(found.id);
      if (found.stale) {
        return problem(400, 'validation_failed', {
          detail: 'query.custom.region is not a field of this list.',
        });
      }
      if (found.forbidden) {
        return problem(403, 'field_forbidden', {
          detail: 'You may not filter by this field.',
        });
      }
      return HttpResponse.json({
        view: found,
        params: {
          ...found.query,
          ...(found.columns && { fields: found.columns.join(',') }),
        },
        columns: found.columns,
        hiddenColumns: [],
      });
    }),
    http.patch('/v1/views/:id', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push({ id: params.id as string, body });
      if (body.name === 'Taken') return problem(409, 'conflict');
      const saved = { ...views.get(params.id as string)!, ...body };
      views.set(saved.id, saved as SavedView);
      return HttpResponse.json(saved);
    }),
    http.delete('/v1/views/:id', ({ params }) => {
      calls.deleted.push(params.id as string);
      views.delete(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { calls };
}
