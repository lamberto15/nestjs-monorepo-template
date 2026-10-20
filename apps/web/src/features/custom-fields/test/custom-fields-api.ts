import { http, HttpResponse } from 'msw/http';
import type { CustomField } from '@/lib/custom-fields';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

// The custom fields API in memory (msw): list with includeInactive, create,
// update, deactivate and reorder, recording what the page sent.

export const field = (over: Partial<CustomField> = {}): CustomField => ({
  id: '0199a3f2-0000-7000-8000-000000000a01',
  subject: 'TestItem',
  key: 'region',
  label: 'Region',
  description: null,
  type: 'select',
  options: [
    { value: 'eu', label: 'Europe' },
    { value: 'us', label: 'Americas' },
  ],
  required: false,
  default: null,
  validation: null,
  position: 0,
  filterable: true,
  sortable: false,
  active: true,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

export const AMOUNT = field({
  id: '0199a3f2-0000-7000-8000-000000000a02',
  key: 'amount',
  label: 'Amount',
  type: 'number',
  options: null,
  validation: { min: 0, max: 100 },
  position: 1,
});

/**
 * Signs the user in with these permissions and serves `fields` for a subject (TestItem unless given).
 * `calls` holds the bodies the page sent; `fail` makes the next write answer
 * a problem.
 */
export function useCustomFieldsApi(options: {
  can: string[];
  fields: CustomField[];
  subject?: string;
  /** What `GET /v1/custom-fields/subjects` answers (TestItem unless given). */
  subjects?: { subject: string; label: { singular: string; plural: string } }[];
}) {
  const subject = options.subject ?? 'TestItem';
  let fields = [...options.fields];
  const calls = {
    created: [] as unknown[],
    patched: [] as { id: string; body: unknown }[],
    deactivated: [] as string[],
    reordered: [] as unknown[],
    reads: [] as string[],
  };
  const fail: { next?: Response } = {};
  useSignedIn(options.can);
  server.use(
    http.get('/v1/custom-fields/subjects', () =>
      HttpResponse.json({
        items: options.subjects ?? [
          {
            subject: 'TestItem',
            label: { singular: 'Test item', plural: 'Test items' },
          },
        ],
      }),
    ),
    http.get('/v1/custom-fields', ({ request }) => {
      const url = new URL(request.url);
      calls.reads.push(url.search);
      if (url.searchParams.get('subject') !== subject) {
        return problem(404, 'not_found');
      }
      const all = url.searchParams.get('includeInactive') === 'true';
      return HttpResponse.json({
        items: fields.filter((f) => all || f.active),
      });
    }),
    http.post('/v1/custom-fields', async ({ request }) => {
      const body = (await request.json()) as Partial<CustomField>;
      calls.created.push(body);
      if (fail.next) return fail.next;
      const created = field({
        ...body,
        id: '0199a3f2-0000-7000-8000-000000000aff',
        position: fields.length,
        options: body.options ?? null,
        validation: body.validation ?? null,
      });
      fields = [...fields, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch('/v1/custom-fields/:id', async ({ params, request }) => {
      const body = (await request.json()) as Partial<CustomField>;
      calls.patched.push({ id: params.id as string, body });
      if (fail.next) return fail.next;
      fields = fields.map((f) => (f.id === params.id ? { ...f, ...body } : f));
      return HttpResponse.json(fields.find((f) => f.id === params.id));
    }),
    http.delete('/v1/custom-fields/:id', ({ params }) => {
      calls.deactivated.push(params.id as string);
      fields = fields.map((f) =>
        f.id === params.id ? { ...f, active: false } : f,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.put('/v1/custom-fields/order', async ({ request }) => {
      const body = (await request.json()) as { ids: string[] };
      calls.reordered.push(body);
      fields = [
        ...body.ids.flatMap((id) => fields.filter((f) => f.id === id)),
        ...fields.filter((f) => !body.ids.includes(f.id)),
      ];
      return HttpResponse.json({ items: fields });
    }),
  );
  return { calls, fail };
}
