import { http, HttpResponse } from 'msw/http';
import type { NamingSeries } from '@/lib/naming-series';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

// The naming series API in memory (msw): the list, subjects, preview, create,
// update, delete and counter, recording what the page sent. A pattern the
// subject has is a 409, a pattern without a run of # a 400, a counter below
// the last value taken a 409, as the API's.

export const series = (over: Partial<NamingSeries> = {}): NamingSeries => ({
  id: 's1',
  subject: 'Note',
  pattern: 'NOTE-.YYYY.-.#####',
  label: 'Notes',
  isDefault: true,
  example: 'NOTE-2026-00043',
  dateField: null,
  conditions: [],
  priority: 0,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const SERIES = [
  series(),
  series({
    id: 's2',
    pattern: 'MEMO-.YY.-.###',
    label: 'Memos',
    isDefault: false,
    example: 'MEMO-26-007',
  }),
];

export const SUBJECTS = [
  {
    subject: 'Note',
    declaredPattern: 'NOTE-.YYYY.-.#####',
    fields: [{ name: 'title', kind: 'text' as const }],
  },
  {
    subject: 'Invoice',
    declaredPattern: 'INV-.YYYY.-.#####',
    fields: [
      { name: 'code', kind: 'text' as const },
      { name: 'total', kind: 'number' as const },
      { name: 'paid', kind: 'boolean' as const },
      { name: 'issuedOn', kind: 'date' as const },
    ],
  },
];

export const VARIABLES = [
  { name: 'FY', description: 'The fiscal year.' },
  { name: 'ABBR', description: 'The abbreviation of the company.' },
];

/** The last value taken by the counter of every series in the fake API. */
export const LAST_TAKEN = 42;

export function useNamingSeriesApi(options: {
  can: string[];
  series?: NamingSeries[];
}) {
  let rows = [...(options.series ?? SERIES)];
  const calls = {
    previews: [] as Record<string, unknown>[],
    created: [] as Record<string, unknown>[],
    patched: [] as { id: string; body: Record<string, unknown> }[],
    deleted: [] as string[],
    counters: [] as { id: string; body: Record<string, unknown> }[],
    reads: [] as (string | null)[],
  };
  useSignedIn(options.can);
  server.use(
    http.get('/v1/naming-series/subjects', () =>
      HttpResponse.json({ items: SUBJECTS }),
    ),
    http.get('/v1/naming-series/variables', () =>
      HttpResponse.json({ items: VARIABLES }),
    ),
    http.post('/v1/naming-series/preview', async ({ request }) => {
      const body = (await request.json()) as {
        pattern: string;
        values?: Record<string, string | number>;
      };
      const pattern = body.pattern;
      calls.previews.push(body);
      if (!pattern.includes('#')) {
        return problem(400, 'validation_failed', {
          detail: 'The pattern needs one run of # for the counter.',
        });
      }
      return HttpResponse.json({
        key: pattern,
        current: body.values ? 7 : 0,
        next: pattern
          .replace(/#+/, '00001')
          .replace(/\{(\w+)\}/g, (all, name: string) =>
            String(body.values?.[name] ?? all),
          ),
      });
    }),
    http.get('/v1/naming-series', ({ request }) => {
      const subject = new URL(request.url).searchParams.get('subject');
      calls.reads.push(subject);
      return HttpResponse.json({
        items: rows.filter((r) => !subject || r.subject === subject),
        nextCursor: null,
      });
    }),
    http.post('/v1/naming-series', async ({ request }) => {
      const body = (await request.json()) as Record<string, any>;
      calls.created.push(body);
      if (
        rows.some(
          (r) => r.subject === body.subject && r.pattern === body.pattern,
        )
      ) {
        return problem(409, 'conflict');
      }
      const created = series({
        id: `n${rows.length + 1}`,
        subject: body.subject,
        pattern: body.pattern,
        label: body.label ?? null,
        isDefault: false,
        dateField: body.dateField ?? null,
        conditions: body.conditions ?? [],
        priority: body.priority ?? 0,
      });
      rows = [...rows, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch('/v1/naming-series/:id', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push({ id: params.id as string, body });
      const found = rows.find((r) => r.id === params.id);
      if (!found) return problem(404, 'not_found');
      const saved = { ...found, ...body } as NamingSeries;
      rows = rows.map((r) => {
        if (r.id === saved.id) return saved;
        return body.isDefault && r.subject === saved.subject
          ? { ...r, isDefault: false }
          : r;
      });
      return HttpResponse.json(saved);
    }),
    http.delete('/v1/naming-series/:id', ({ params }) => {
      calls.deleted.push(params.id as string);
      rows = rows.filter((r) => r.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/v1/naming-series/:id/counter', () =>
      HttpResponse.json({
        key: 'NOTE-2026-{#}',
        current: LAST_TAKEN,
        next: 'NOTE-2026-00043',
      }),
    ),
    http.put('/v1/naming-series/:id/counter', async ({ params, request }) => {
      const body = (await request.json()) as {
        current: number;
        values?: Record<string, unknown>;
      };
      calls.counters.push({ id: params.id as string, body });
      if (body.current < LAST_TAKEN) return problem(409, 'conflict');
      return HttpResponse.json({
        key: 'NOTE-2026-{#}',
        current: body.current,
        next: `NOTE-2026-${String(body.current + 1).padStart(5, '0')}`,
      });
    }),
  );
  return { calls };
}
