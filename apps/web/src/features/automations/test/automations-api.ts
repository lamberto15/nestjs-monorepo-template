import { http, HttpResponse } from 'msw/http';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import type { AutomationRule, Simulation } from '../api';

// The automation rules API in memory (msw): the list, the subjects, a
// rule's runs, create, simulate, activate, recording what the page sent.

export const RULE_ID = '0199a3f2-0000-7000-8000-000000000801';
export const RECORD_ID = '0199a3f2-0000-7000-8000-000000000802';

export const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: RULE_ID,
  name: 'Tag urgent notes',
  subject: 'Note',
  trigger: 'created',
  field: null,
  filters: { 'title.contains': 'urgent' },
  actions: [{ type: 'setField', field: 'title', value: 'Urgent' }],
  status: 'draft',
  version: 1,
  owner: null,
  activatedAt: null,
  disabledReason: null,
  failures: 0,
  lastRunAt: null,
  lastStatus: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
  ...over,
});

export const SIMULATION: Simulation = {
  subject: 'Note',
  limit: 20,
  matched: 1,
  truncated: false,
  triggerSimulated: true,
  matches: [
    {
      recordId: RECORD_ID,
      title: 'An urgent note',
      actions: [
        {
          type: 'setField',
          allowed: true,
          reason: null,
          detail: 'title = "Urgent"',
        },
      ],
    },
  ],
};

export function useAutomationsApi(options: {
  can: string[];
  rules?: AutomationRule[];
}) {
  let rules = [...(options.rules ?? [rule()])];
  const calls = {
    created: [] as Record<string, unknown>[],
    simulated: [] as Record<string, unknown>[],
    activated: [] as string[],
  };
  useSignedIn(options.can);
  server.use(
    http.get('/v1/automation-rules', () =>
      HttpResponse.json({ items: rules, nextCursor: null }),
    ),
    http.get('/v1/automation-rules/subjects', () =>
      HttpResponse.json({
        items: [
          {
            subject: 'Note',
            path: 'notes',
            fields: ['title', 'body', 'status'],
            settable: ['title', 'body'],
            tags: false,
          },
        ],
      }),
    ),
    http.get('/v1/automation-rules/:id/runs', () =>
      HttpResponse.json({
        items: [
          {
            id: '0199a3f2-0000-7000-8000-000000000803',
            ruleVersion: 1,
            recordId: RECORD_ID,
            status: 'failed',
            actions: [
              {
                type: 'notify',
                allowed: false,
                reason: 'no_recipient',
                detail: '0 of 1',
              },
            ],
            error: 'notify: no_recipient',
            createdAt: '2026-10-21T09:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    ),
    http.post('/v1/automation-rules/simulate', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.simulated.push(body);
      return HttpResponse.json(SIMULATION);
    }),
    http.post('/v1/automation-rules', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.created.push(body);
      const created = rule({
        id: '0199a3f2-0000-7000-8000-000000000804',
        name: body.name as string,
      });
      rules = [created, ...rules];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post('/v1/automation-rules/:id/activate', ({ params }) => {
      calls.activated.push(params.id as string);
      const found = rules.find((r) => r.id === params.id);
      if (!found) return problem(404, 'not_found');
      const active = { ...found, status: 'active' as const, owner: 'user:ada' };
      rules = rules.map((r) => (r.id === active.id ? active : r));
      return HttpResponse.json(active);
    }),
  );
  return { calls };
}
