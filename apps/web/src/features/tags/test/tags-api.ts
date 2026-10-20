import { http, HttpResponse } from 'msw/http';
import type { Tag } from '@/lib/tags';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

// The tags API in memory (msw): the list across subjects, update and delete,
// recording what the page sent. A rename to a name the subject has (whatever
// the case) is a 409, as the API's.

export const tag = (over: Partial<Tag> = {}): Tag => ({
  id: 't1',
  subject: 'TestItem',
  name: 'Urgent',
  color: '#ef4444',
  description: 'Needs an answer today',
  usageCount: 0,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const TAGS = [
  tag(),
  tag({ id: 't2', name: 'Q3', color: null, description: null }),
  tag({ id: 't3', subject: 'Invoice', name: 'Overdue', color: '#f59e0b' }),
];

export function useTagsApi(options: { can: string[]; tags?: Tag[] }) {
  let tags = [...(options.tags ?? TAGS)];
  const calls = {
    patched: [] as { id: string; body: Record<string, unknown> }[],
    deleted: [] as string[],
    /** The `subject` query of each list read (null: none, every subject). */
    reads: [] as (string | null)[],
  };
  useSignedIn(options.can);
  server.use(
    http.get('/v1/tags', ({ request }) => {
      const url = new URL(request.url);
      const subject = url.searchParams.get('subject');
      calls.reads.push(subject);
      // The API's cursor pages, by name; the cursor here is an offset.
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const rows = tags
        .filter((t) => !subject || t.subject === subject)
        .toSorted((x, y) => x.name.localeCompare(y.name));
      const end = start + limit;
      return HttpResponse.json({
        items: rows.slice(start, end),
        nextCursor: end < rows.length ? String(end) : null,
      });
    }),
    http.patch('/v1/tags/:id', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push({ id: params.id as string, body });
      const found = tags.find((t) => t.id === params.id);
      if (!found) return problem(404, 'not_found');
      if (
        typeof body.name === 'string' &&
        tags.some(
          (t) =>
            t.id !== found.id &&
            t.subject === found.subject &&
            t.name.toLowerCase() === (body.name as string).toLowerCase(),
        )
      ) {
        return problem(409, 'conflict');
      }
      const saved = { ...found, ...body } as Tag;
      tags = tags.map((t) => (t.id === saved.id ? saved : t));
      return HttpResponse.json(saved);
    }),
    http.delete('/v1/tags/:id', ({ params }) => {
      calls.deleted.push(params.id as string);
      tags = tags.filter((t) => t.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { calls };
}
