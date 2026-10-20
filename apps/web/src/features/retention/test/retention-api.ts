import { http, HttpResponse } from 'msw/http';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import type { RetentionRule } from '../api';

// The retention API in memory (msw): the list and the set, recording what the
// page sent. Days below the rule's minimum are a 400, as the API's.

export const rule = (over: Partial<RetentionRule> = {}): RetentionRule => ({
  name: 'note',
  label: 'Notes',
  subject: 'Note',
  action: 'purge',
  defaultDays: 730,
  minDays: 30,
  enabled: false,
  days: 730,
  lastRunAt: null,
  lastCount: null,
  ...over,
});

export function useRetentionApi(options: {
  can: string[];
  rules?: RetentionRule[];
}) {
  let rules = options.rules ?? [
    rule(),
    rule({
      name: 'contact',
      label: 'Contacts',
      subject: 'Contact',
      action: 'anonymise',
      enabled: true,
      days: 365,
      lastRunAt: '2026-10-19T04:10:00.000Z',
      lastCount: 12,
    }),
  ];
  const calls = {
    reads: 0,
    put: [] as { name: string; body: Record<string, unknown> }[],
  };
  useSignedIn(options.can);
  server.use(
    http.get('/v1/retention/rules', () => {
      calls.reads += 1;
      return HttpResponse.json({ items: rules, nextCursor: null });
    }),
    http.put('/v1/retention/rules/:name', async ({ params, request }) => {
      const body = (await request.json()) as {
        enabled: boolean;
        days?: number;
      };
      calls.put.push({ name: params.name as string, body });
      const found = rules.find((r) => r.name === params.name);
      if (!found) return problem(404, 'not_found');
      if (body.days !== undefined && body.days < found.minDays) {
        return problem(400, 'validation_failed');
      }
      const saved = { ...found, ...body, days: body.days ?? found.days };
      rules = rules.map((r) => (r.name === saved.name ? saved : r));
      return HttpResponse.json(saved);
    }),
  );
  return { calls };
}
