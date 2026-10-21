import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server } from '@/test/server';
import { findToast } from '@/test/toast';

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

const RUN = '0199a3f2-0000-7000-8000-000000000801';

const run = (over: object = {}) => ({
  id: RUN,
  source: 'note',
  subject: 'Note',
  recordId: NOTE_ID,
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
  useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
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

describe('AI helper on the note page', () => {
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
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('Summarizing…')).toBeVisible();
    expect(
      await screen.findByText('Renewals come first.', {}, { timeout: 4000 }),
    ).toBeVisible();
    expect(screen.getByText('Upsell')).toBeVisible();
    expect(posted).toEqual([
      { source: 'note', recordId: NOTE_ID, task: 'summarize' },
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
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Classify' }));
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
    server.use(
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, realtime: true }),
      ),
    );
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Summarize' }));
    await screen.findByText('Summarizing…');
    await waitFor(() => expect(connections.length).toBeGreaterThan(0));
    act(() =>
      connections.at(-1)!.emit('ai.ready', {
        id: RUN,
        subject: 'Note',
        recordId: NOTE_ID,
        task: 'summarize',
      }),
    );
    expect(await screen.findByText('Done early.')).toBeVisible();
  });

  it('shows why a run failed', async () => {
    useAiApi({
      states: [{ status: 'failed', error: 'The provider timed out.' }],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('The provider timed out.')).toBeVisible();
  });

  it('says the answer is gone when it is no longer kept', async () => {
    useAiApi({ states: [{ status: 'completed', output: null }] });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Summarize' }));
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
      await renderApp(`/notes/${NOTE_ID}`);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Summarize' }),
      );
      expect(await screen.findByText(text)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Summarize' }),
      ).not.toBeInTheDocument();
    },
  );

  it('tells about a run already pending (409) and a spent quota (429)', async () => {
    let answer = problem(409, 'ai_pending');
    useAiApi({ post: () => answer });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Summarize' }));
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
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    await waitFor(() =>
      expect(screen.queryByText('AI helper')).not.toBeInTheDocument(),
    );
  });

  it('is shown when the setting is visible and on', async () => {
    useAiApi({ aiEnabled: true });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(
      await screen.findByRole('button', { name: 'Summarize' }),
    ).toBeVisible();
  });

  it('is hidden when the server has no AI provider (features.ai off)', async () => {
    useAiApi({ aiEnabled: true });
    server.use(
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, realtime: false, ai: false }),
      ),
    );
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    await waitFor(() =>
      expect(screen.queryByText('AI helper')).not.toBeInTheDocument(),
    );
  });
});
