import { http, HttpResponse } from 'msw/http';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import type { LegalHold } from '../api';

// The legal holds API in memory (msw): the cursor-paged list with its
// `active` and `subject` filters, one hold, place and release (a 409 when
// released already), recording what the page sent.

export const NOTE_HOLD = '0199a3f2-0000-7000-8000-000000000601';
export const RECORD_ID = '0199a3f2-0000-7000-8000-000000000602';

export const hold = (over: Partial<LegalHold> = {}): LegalHold => ({
  id: NOTE_HOLD,
  subject: 'Note',
  recordId: null,
  reason: 'Dispute with Acme, case 2026-114',
  active: true,
  placedBy: 'user:ada',
  placedAt: '2026-10-17T09:00:00.000Z',
  releasedAt: null,
  releasedBy: null,
  releaseNote: null,
  ...over,
});

export const HOLDS = [
  hold(),
  hold({
    id: '0199a3f2-0000-7000-8000-000000000603',
    subject: 'User',
    recordId: RECORD_ID,
    reason: 'Audit of a leaver',
    active: false,
    releasedAt: '2026-10-18T09:00:00.000Z',
    releasedBy: 'user:grace',
    releaseNote: 'Audit closed',
  }),
];

export function useLegalHoldsApi(options: {
  can: string[];
  holds?: LegalHold[];
  pageSize?: number;
}) {
  let holds = [...(options.holds ?? HOLDS)];
  const calls = {
    /** The query string of each list read. */
    reads: [] as URLSearchParams[],
    placed: [] as Record<string, unknown>[],
    released: [] as { id: string; body: Record<string, unknown> }[],
  };
  useSignedIn(options.can);
  server.use(
    http.get('/v1/legal-holds', ({ request }) => {
      const url = new URL(request.url);
      calls.reads.push(url.searchParams);
      const active = url.searchParams.get('active');
      const subject = url.searchParams.get('subject');
      const rows = holds.filter(
        (h) =>
          (active === null || h.active === (active === 'true')) &&
          (!subject || h.subject === subject),
      );
      const size = options.pageSize ?? 50;
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = start + size;
      return HttpResponse.json({
        items: rows.slice(start, end),
        nextCursor: end < rows.length ? String(end) : null,
      });
    }),
    http.get('/v1/legal-holds/:id', ({ params }) => {
      const found = holds.find((h) => h.id === params.id);
      return found ? HttpResponse.json(found) : problem(404, 'not_found');
    }),
    http.post('/v1/legal-holds', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.placed.push(body);
      const placed = hold({
        id: `0199a3f2-0000-7000-8000-00000000070${calls.placed.length}`,
        subject: body.subject as string,
        recordId: (body.recordId as string | undefined) ?? null,
        reason: body.reason as string,
      });
      holds = [placed, ...holds];
      return HttpResponse.json(placed, { status: 201 });
    }),
    http.post('/v1/legal-holds/:id/release', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.released.push({ id: params.id as string, body });
      const found = holds.find((h) => h.id === params.id);
      if (!found) return problem(404, 'not_found');
      if (!found.active) return problem(409, 'legal_hold_released');
      const released = {
        ...found,
        active: false,
        releasedAt: '2026-10-20T09:00:00.000Z',
        releasedBy: 'user:ada',
        releaseNote: (body.note as string | undefined) ?? null,
      };
      holds = holds.map((h) => (h.id === released.id ? released : h));
      return HttpResponse.json(released);
    }),
  );
  return { calls };
}
