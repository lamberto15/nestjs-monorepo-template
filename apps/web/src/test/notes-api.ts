import { http, HttpResponse } from 'msw/http';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

// The notes API as the record pages see it, in memory (msw): enough of
// POST/GET/PATCH/DELETE/restore, ETags and the recycle bin to drive the pages.

export interface TestNote {
  id: string;
  number: string;
  title: string;
  body?: string;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  deletedAt: string | null;
  tags: { id: string; name: string; color: string | null }[];
}

export const NOTE_ID = '0199a3f2-0000-7000-8000-000000000501';
const CREATED_ID = '0199a3f2-0000-7000-8000-000000000502';

export const sampleNote = (over: Partial<TestNote> = {}): TestNote => ({
  id: NOTE_ID,
  number: 'NOTE-2026-00001',
  title: 'Q3 targets',
  body: 'Renewals first.',
  status: 'draft',
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  publishedAt: null,
  deletedAt: null,
  tags: [{ id: 't1', name: 'Internal', color: '#6b7280' }],
  ...over,
});

const description = {
  subject: 'Note',
  fields: [
    {
      name: 'title',
      type: 'string',
      operators: ['contains'],
      sortable: true,
      custom: false,
    },
  ],
  select: ['id', 'number', 'title', 'status', 'tags', 'createdAt'],
  search: false,
  recycleBin: true,
  defaultSort: '-createdAt',
  limits: { defaultLimit: 50, maxLimit: 100 },
};

/** Signs the user in with these permissions and serves the notes in `notes`. */
export function useNotesApi(options: { can: string[]; notes: TestNote[] }) {
  const notes = new Map(options.notes.map((note) => [note.id, { ...note }]));
  let version = 1;
  const etagOf = (note: TestNote) => `"${note.id}-${version}-${note.title}"`;
  const calls = {
    created: [] as { body: unknown; key: string | null }[],
    patched: [] as { id: string; body: unknown; ifMatch: string | null }[],
    deleted: [] as string[],
    restored: [] as string[],
    listQueries: [] as string[],
  };
  /** Another user's write: the note changes, its ETag with it. */
  const changeElsewhere = (id: string, changes: Partial<TestNote>) => {
    version += 1;
    notes.set(id, { ...notes.get(id)!, ...changes });
  };

  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        can: Object.fromEntries(options.can.map((p) => [p, true])),
      }),
    ),
    // The sidebar's bell asks for its count; without realtime there is no socket.
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/lists/:subject', () => HttpResponse.json(description)),
    http.get('/v1/notes', ({ request }) => {
      const url = new URL(request.url);
      calls.listQueries.push(url.search);
      const bin = url.searchParams.get('deleted') === 'true';
      const items = [...notes.values()].filter((n) => !!n.deletedAt === bin);
      return HttpResponse.json({ items, page: 1, pageCount: 1 });
    }),
    http.post('/v1/notes', async ({ request }) => {
      const body = (await request.json()) as { title: string; body: string };
      calls.created.push({ body, key: request.headers.get('idempotency-key') });
      if (body.title === 'Taken') {
        return problem(400, 'validation_failed', {
          errors: [{ path: 'title', message: 'That title is taken' }],
        });
      }
      const note = sampleNote({ ...body, id: CREATED_ID });
      notes.set(note.id, note);
      return HttpResponse.json(note, { status: 201 });
    }),
    http.get('/v1/notes/:id', ({ params }) => {
      const note = notes.get(params.id as string);
      if (!note || note.deletedAt) return problem(404, 'not_found');
      return HttpResponse.json(note, { headers: { etag: etagOf(note) } });
    }),
    http.patch('/v1/notes/:id', async ({ params, request }) => {
      const id = params.id as string;
      const note = notes.get(id);
      if (!note) return problem(404, 'not_found');
      const ifMatch = request.headers.get('if-match');
      const body = (await request.json()) as Partial<TestNote>;
      calls.patched.push({ id, body, ifMatch });
      if (ifMatch && ifMatch !== etagOf(note)) {
        return problem(412, 'precondition_failed', { etag: etagOf(note) });
      }
      version += 1;
      const saved = { ...note, ...body };
      notes.set(id, saved);
      return HttpResponse.json(saved, { headers: { etag: etagOf(saved) } });
    }),
    http.delete('/v1/notes/:id', ({ params }) => {
      const id = params.id as string;
      calls.deleted.push(id);
      notes.set(id, {
        ...notes.get(id)!,
        deletedAt: '2026-10-17T10:00:00.000Z',
      });
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/v1/notes/:id/restore', ({ params }) => {
      const id = params.id as string;
      calls.restored.push(id);
      const restored = { ...notes.get(id)!, deletedAt: null };
      notes.set(id, restored);
      return HttpResponse.json(restored);
    }),
  );
  return { calls, changeElsewhere, notes };
}
