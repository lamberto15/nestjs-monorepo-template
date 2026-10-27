import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeProvider } from '@/lib/realtime';
import type { Features } from '@/lib/session';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderComponent } from '@/test/render-component';
import { problem, server } from '@/test/server';
import { findToast } from '@/test/toast';
import { AiPanel } from './ai-panel';

// The AI helper's panel (summarize, classify) on a test-only subject's
// record, mounted alone: no feature's page hosts it, so these tests stand
// when `pnpm feature:remove` takes a feature. A feature's own tests only
// check that its page shows the panel with its `source`.

const connections: FakeRealtime[] = [];
vi.mock('@nestjs-monorepo-template/api-client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@nestjs-monorepo-template/api-client')
  >()),
  createRealtime: vi.fn(() => {
    const fake = createFakeRealtime();
    connections.push(fake);
    return fake;
  }),
}));

beforeEach(() => {
  connections.length = 0;
});

const SOURCE = 'test-item';
const ITEM_ID = '0199a3f2-0000-7000-8000-000000000601';
const RUN = '0199a3f2-0000-7000-8000-000000000801';

const run = (over: object = {}) => ({
  id: RUN,
  source: SOURCE,
  subject: 'TestItem',
  recordId: ITEM_ID,
  task: 'summarize',
  promptVersion: 'v1',
  model: 'fake-model',
  status: 'completed',
  output: null,
  inputTokens: 10,
  outputTokens: 5,
  cached: false,
  error: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
  ...over,
});

/** The AI routes: what POST answers and the run's states in turn. */
function useAiApi(
  options: {
    post?: () => Response;
    states?: object[];
    aiEnabled?: boolean;
  } = {},
) {
  const posted: { source: string; recordId: string; task: string }[] = [];
  const states = [...(options.states ?? [])];
  server.use(
    http.post('/v1/ai/runs', async ({ request }) => {
      posted.push((await request.json()) as (typeof posted)[number]);
      return (
        options.post?.() ??
        HttpResponse.json({ id: RUN, status: 'queued' }, { status: 202 })
      );
    }),
    http.get('/v1/ai/runs/:id', () => {
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return HttpResponse.json(run(state));
    }),
  );
  if (options.aiEnabled !== undefined) {
    // GET /v1/settings lists the public ai.enabled to every signed-in user.
    server.use(
      http.get('/v1/settings', () =>
        HttpResponse.json({
          items: [
            {
              key: 'ai.enabled',
              label: 'AI helper',
              description: null,
              flag: false,
              scopes: ['tenant'],
              public: true,
              value: options.aiEnabled,
              source: 'default',
              default: false,
              type: 'boolean',
              schema: {},
              canEdit: true,
              canSetMine: false,
              platform: null,
              canEditPlatform: false,
            },
          ],
        }),
      ),
    );
  }
  return posted;
}

// Without a socket by default: the run is then followed by the fast poll.
const mountPanel = (features: Partial<Features> = { realtime: false }) =>
  renderComponent(
    <RealtimeProvider>
      <AiPanel source={SOURCE} recordId={ITEM_ID} />
    </RealtimeProvider>,
    { can: ['TestItem.read'], features },
  );

const ask = async (name: 'Summarize' | 'Classify') => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name }));
  return user;
};

const expectPanelHidden = () =>
  waitFor(() =>
    expect(screen.queryByText('AI helper')).not.toBeInTheDocument(),
  );

describe('AI helper panel', () => {
  it('summarizes: asks, shows pending, then the answer', async () => {
    const posted = useAiApi({
      states: [
        { status: 'running' },
        {
          status: 'completed',
          output: {
            summary: 'Renewals come first.',
            keyPoints: ['Renew', 'Upsell'],
          },
        },
      ],
    });
    await mountPanel();
    await ask('Summarize');
    expect(await screen.findByText('Summarizing…')).toBeVisible();
    expect(
      await screen.findByText('Renewals come first.', {}, { timeout: 4000 }),
    ).toBeVisible();
    expect(screen.getByText('Upsell')).toBeVisible();
    expect(posted).toEqual([
      { source: SOURCE, recordId: ITEM_ID, task: 'summarize' },
    ]);
  });

  it('classifies and shows the sentiment and topic', async () => {
    useAiApi({
      states: [
        {
          task: 'classify',
          output: { sentiment: 'negative', topic: 'churn' },
        },
      ],
    });
    await mountPanel();
    await ask('Classify');
    expect(await screen.findByText('Negative')).toBeVisible();
    expect(screen.getByText('churn')).toBeVisible();
  });

  it('settles on the ai.ready event without waiting for the poll', async () => {
    useAiApi({
      states: [
        { status: 'running' },
        { output: { summary: 'Done early.', keyPoints: [] } },
      ],
    });
    await mountPanel({ realtime: true });
    await ask('Summarize');
    await screen.findByText('Summarizing…');
    await waitFor(() => expect(connections.length).toBeGreaterThan(0));
    act(() =>
      connections.at(-1)!.emit('ai.ready', {
        id: RUN,
        subject: 'TestItem',
        recordId: ITEM_ID,
        task: 'summarize',
      }),
    );
    expect(await screen.findByText('Done early.')).toBeVisible();
  });

  it('shows why a run failed', async () => {
    useAiApi({
      states: [{ status: 'failed', error: 'The provider timed out.' }],
    });
    await mountPanel();
    await ask('Summarize');
    expect(await screen.findByText('The provider timed out.')).toBeVisible();
  });

  it('says the answer is gone when it is no longer kept', async () => {
    useAiApi({ states: [{ status: 'completed', output: null }] });
    await mountPanel();
    await ask('Summarize');
    expect(
      await screen.findByText('The answer is no longer kept. Ask again.'),
    ).toBeVisible();
  });

  it.each([
    [403, 'ai_disabled', /off for this workspace/],
    [503, 'ai_unavailable', /not available on this server/],
  ])(
    'replaces the buttons with a notice on %s %s',
    async (status, code, text) => {
      useAiApi({ post: () => problem(status, code) });
      await mountPanel();
      await ask('Summarize');
      expect(await screen.findByText(text)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Summarize' }),
      ).not.toBeInTheDocument();
    },
  );

  it('tells about a run already pending (409) and a spent quota (429)', async () => {
    let answer = problem(409, 'ai_pending');
    useAiApi({ post: () => answer });
    await mountPanel();
    const user = await ask('Summarize');
    await findToast('This request is already running. Try again in a moment.');
    answer = problem(429, 'ai_quota_exceeded');
    await user.click(screen.getByRole('button', { name: 'Classify' }));
    await findToast(
      'The daily limit of the AI helper has been reached. Try again tomorrow.',
    );
    // The buttons stay: neither error says the helper is off.
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeVisible();
  });

  it('is hidden when the tenant setting is visible and off', async () => {
    useAiApi({ aiEnabled: false });
    await mountPanel();
    await expectPanelHidden();
  });

  it('is shown when the setting is visible and on', async () => {
    useAiApi({ aiEnabled: true });
    await mountPanel();
    expect(
      await screen.findByRole('button', { name: 'Summarize' }),
    ).toBeVisible();
  });

  it('is hidden when the server has no AI provider (features.ai off)', async () => {
    useAiApi({ aiEnabled: true });
    await mountPanel({ realtime: false, ai: false });
    await expectPanelHidden();
  });
});
