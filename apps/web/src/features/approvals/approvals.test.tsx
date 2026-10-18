import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_ID, sampleNote, useNotesApi } from '@/test/notes-api';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

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

const REQUEST_ID = '0199a3f2-0000-7000-8000-000000000701';
const OTHER_USER = '0199a3f2-0000-7000-8000-000000000009';

const item = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  key: 'Note.publish',
  subject: 'Note',
  recordId: NOTE_ID,
  action: 'publish',
  status: 'pending',
  requester: `user:${OTHER_USER}`,
  requesterName: 'Maya Patel',
  title: 'Q3 targets',
  link: `/notes/${NOTE_ID}`,
  payload: { title: 'Q3 targets' },
  policyVersion: 0,
  round: 0,
  currentStage: 0,
  stageCount: 2,
  stageName: 'Editor review',
  dueAt: null,
  comment: 'Ready for review',
  outcomeReason: null,
  endedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...item(),
  stages: [
    { index: 0, name: 'Editor review', mode: { type: 'any' }, state: 'active' },
    {
      index: 1,
      name: 'Finance',
      mode: { type: 'quorum', n: 2 },
      state: 'waiting',
    },
  ],
  assignments: [
    {
      id: 'a1',
      round: 0,
      stage: 0,
      approverId: signedInUser.user.id,
      approverName: 'Ada Lovelace',
      status: 'pending',
      comment: null,
      decidedAt: null,
      decidedBy: null,
      decidedByName: null,
      onBehalfOf: null,
      escalated: false,
    },
  ],
  timeline: [
    {
      id: 't1',
      type: 'requested',
      actor: `user:${OTHER_USER}`,
      actorName: 'Maya Patel',
      round: 0,
      stage: null,
      details: { comment: 'Ready for review' },
      createdAt: '2026-10-17T08:00:00.000Z',
    },
    {
      id: 't2',
      type: 'stage_started',
      actor: 'system:approvals',
      actorName: 'System',
      round: 0,
      stage: 0,
      details: null,
      createdAt: '2026-10-17T08:00:01.000Z',
    },
  ],
  can: { decide: true, cancel: false, resubmit: false },
  ...over,
});

type Options = {
  waiting?: ReturnType<typeof item>[];
  requested?: ReturnType<typeof item>[];
  ended?: ReturnType<typeof item>[];
  can?: Record<string, boolean>;
  realtime?: boolean;
  impersonating?: boolean;
  request?: ReturnType<typeof detail>;
};

/** The approvals API as the inbox sees it; `calls` records what was sent. */
function useApprovalsApi(options: Options = {}) {
  const state = {
    waiting: options.waiting ?? [item()],
    listQueries: [] as URLSearchParams[],
    decisions: [] as {
      path: string;
      body: unknown;
      ifMatch: string | null;
    }[],
    delegations: [] as unknown[],
    ended: [] as string[],
  };
  const user = options.impersonating
    ? {
        ...signedInUser.user,
        impersonator: { id: 'x', email: 'x@example.com' },
      }
    : signedInUser.user;
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({ ...signedInUser, user, can: options.can ?? {} }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({
        ...allFeatures,
        realtime: options.realtime ?? false,
      }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/approvals', ({ request }) => {
      const query = new URL(request.url).searchParams;
      state.listQueries.push(query);
      if (query.get('count') === 'true') {
        return HttpResponse.json({
          items: [],
          nextCursor: null,
          total: state.waiting.length,
        });
      }
      if (query.get('recordId')) {
        return HttpResponse.json({
          items: options.request ? [options.request] : [],
          nextCursor: null,
        });
      }
      const items = query.get('assignedToMe')
        ? state.waiting
        : query.get('requestedByMe')
          ? (options.requested ?? [])
          : (options.ended ?? []);
      return HttpResponse.json({ items, nextCursor: null });
    }),
    http.get('/v1/approvals/delegations', () =>
      HttpResponse.json({ items: [] }),
    ),
    http.post('/v1/approvals/delegations', async ({ request }) => {
      const body = await request.json();
      state.delegations.push(body);
      return HttpResponse.json(
        { id: 'd1', ...(body as object) },
        { status: 201 },
      );
    }),
    http.get('/v1/approvals/:id', () =>
      HttpResponse.json(options.request ?? detail(), {
        headers: { etag: '"v1"' },
      }),
    ),
    http.post('/v1/approvals/:id/:decision', async ({ request, params }) => {
      const body = await request.json();
      state.decisions.push({
        path: String(params.decision),
        body,
        ifMatch: request.headers.get('if-match'),
      });
      state.waiting = [];
      return HttpResponse.json(item({ status: 'approved' }));
    }),
    http.get('/v1/access/users', () =>
      HttpResponse.json({
        items: [
          {
            id: OTHER_USER,
            email: 'maya@example.com',
            name: 'Maya Patel',
            active: true,
          },
          {
            id: signedInUser.user.id,
            email: 'ada@example.com',
            name: 'Ada',
            active: true,
          },
        ],
        page: 1,
        nextPage: null,
      }),
    ),
  );
  return state;
}

describe('the nav badge', () => {
  it('shows how many approvals wait for the user', async () => {
    const api = useApprovalsApi({ waiting: [item(), item({ id: 'b' })] });
    await renderApp('/');
    const link = await screen.findByRole('link', { name: /Approvals/ });
    expect(await within(link.parentElement!).findByText('2')).toBeVisible();
    expect(api.listQueries[0]!.get('assignedToMe')).toBe('true');
  });

  it('shows no badge when nothing waits', async () => {
    useApprovalsApi({ waiting: [] });
    await renderApp('/');
    const link = await screen.findByRole('link', { name: /Approvals/ });
    expect(link.parentElement).not.toHaveTextContent(/\d/);
  });

  it('follows the socket when realtime is on', async () => {
    const api = useApprovalsApi({ waiting: [item()], realtime: true });
    await renderApp('/');
    const link = await screen.findByRole('link', { name: /Approvals/ });
    expect(await within(link.parentElement!).findByText('1')).toBeVisible();

    api.waiting = [item(), item({ id: 'b' }), item({ id: 'c' })];
    act(() =>
      connections[0]!.emit('approval.assigned', {
        id: 'c',
        subject: 'Note',
        recordId: NOTE_ID,
        action: 'publish',
        stage: 0,
      }),
    );
    expect(await within(link.parentElement!).findByText('3')).toBeVisible();
  });
});

describe('the inbox', () => {
  it('lists what waits for me, with the record, action, stage and requester', async () => {
    useApprovalsApi();
    await renderApp('/approvals');
    expect(
      await screen.findByRole('heading', { name: 'Approvals' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('link', { name: 'Q3 targets' }),
    ).toHaveAttribute('href', `/notes/${NOTE_ID}`);
    expect(screen.getByText(/Publish a note/)).toBeVisible();
    expect(screen.getByText(/Editor review \(stage 1 of 2\)/)).toBeVisible();
    expect(screen.getByText(/Requested by Maya Patel/)).toBeVisible();
  });

  it('asks the API for each tab, and offers decisions only on the first', async () => {
    const api = useApprovalsApi({
      requested: [item({ id: 'r', title: 'Mine', status: 'approved' })],
      ended: [item({ id: 'e', title: 'Old', status: 'rejected' })],
    });
    const user = userEvent.setup();
    await renderApp('/approvals');
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Requested by me' }));
    expect(await screen.findByText('Mine')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    expect(api.listQueries.some((q) => q.get('requestedByMe') === 'true')).toBe(
      true,
    );

    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText('Old')).toBeVisible();
    expect(
      api.listQueries.some(
        (q) =>
          q.get('status.in') === 'approved,rejected,cancelled,expired,failed',
      ),
    ).toBe(true);
  });

  it('opens on the tab named in the URL', async () => {
    useApprovalsApi({ requested: [item({ title: 'Mine' })] });
    await renderApp('/approvals?tab=requested');
    expect(await screen.findByText('Mine')).toBeVisible();
    expect(
      screen.getByRole('tab', { name: 'Requested by me' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('approves with an optional comment', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Looks good');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText('Nothing is waiting for your decision.'),
    ).toBeVisible();
    expect(api.decisions).toEqual([
      { path: 'approve', body: { comment: 'Looks good' }, ifMatch: null },
    ]);
  });

  it('approves without a comment', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText('Nothing is waiting for your decision.'),
    ).toBeVisible();
    expect(api.decisions[0]!.body).toEqual({});
  });

  it('refuses to reject without a comment, then sends it', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(
      await within(dialog).findByText('Say why you reject it.'),
    ).toBeVisible();
    expect(api.decisions).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox'), 'Not yet');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(
      await screen.findByText('Nothing is waiting for your decision.'),
    ).toBeVisible();
    expect(api.decisions).toEqual([
      { path: 'reject', body: { comment: 'Not yet' }, ifMatch: null },
    ]);
  });

  it('offers no decision while impersonating', async () => {
    useApprovalsApi({ impersonating: true });
    await renderApp('/approvals');
    await screen.findByRole('link', { name: 'Q3 targets' });
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Reject' }),
    ).not.toBeInTheDocument();
  });

  it('delegates my approvals to a person for a period', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await screen.findByRole('button', { name: 'Delegate' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      await within(dialog).findByRole('combobox', { name: 'Delegate to' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Maya Patel' }));
    fireEvent.change(within(dialog).getByLabelText('From'), {
      target: { value: '2026-11-01T09:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Until'), {
      target: { value: '2026-11-08T09:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    expect(await screen.findByText('Delegation created.')).toBeVisible();
    expect(api.delegations).toEqual([
      {
        toUserId: OTHER_USER,
        startsAt: new Date('2026-11-01T09:00').toISOString(),
        endsAt: new Date('2026-11-08T09:00').toISOString(),
      },
    ]);
  });

  it('refuses a delegation that ends before it starts', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await screen.findByRole('button', { name: 'Delegate' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      await within(dialog).findByRole('combobox', { name: 'Delegate to' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Maya Patel' }));
    fireEvent.change(within(dialog).getByLabelText('From'), {
      target: { value: '2026-11-08T09:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Until'), {
      target: { value: '2026-11-01T09:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    expect(
      await within(dialog).findByText('The end must be after the start.'),
    ).toBeVisible();
    expect(api.delegations).toHaveLength(0);
  });
});

describe('the approval page', () => {
  it('shows the stages with their approvers, and the history', async () => {
    useApprovalsApi();
    await renderApp(`/approvals/${REQUEST_ID}`);
    expect(
      await screen.findByRole('heading', { name: 'Q3 targets' }),
    ).toBeVisible();
    expect(screen.getByText('Stage 1 of 2: Editor review')).toBeVisible();
    expect(screen.getByText('Stage 2 of 2: Finance')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Stages' })).getByText(
        'Ada Lovelace',
      ),
    ).toBeVisible();
    expect(screen.getByText('2 approvals needed')).toBeVisible();
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('Requested')).toBeVisible();
    expect(within(history).getByText('Stage started')).toBeVisible();
  });

  it('decides with the ETag it read', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp(`/approvals/${REQUEST_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved.')).toBeVisible();
    expect(api.decisions).toEqual([
      { path: 'approve', body: {}, ifMatch: '"v1"' },
    ]);
  });

  it('offers a changed request a reload on a 412', async () => {
    useApprovalsApi();
    server.use(
      http.post('/v1/approvals/:id/approve', () =>
        problem(412, 'precondition_failed'),
      ),
    );
    const user = userEvent.setup();
    await renderApp(`/approvals/${REQUEST_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await within(dialog).findByText('This request changed'),
    ).toBeVisible();
  });

  it('shows no actions to someone who may not decide', async () => {
    useApprovalsApi({
      request: detail({
        can: { decide: false, cancel: false, resubmit: false },
      }),
    });
    await renderApp(`/approvals/${REQUEST_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  });

  it('shows a not-found state', async () => {
    useApprovalsApi();
    server.use(http.get('/v1/approvals/:id', () => problem(404, 'not_found')));
    await renderApp(`/approvals/${REQUEST_ID}`);
    expect(await screen.findByText('Approval not found')).toBeVisible();
  });
});

describe('the banner on a record', () => {
  it('shows the open approval and lets an approver decide', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    const api = useApprovalsApi({ request: detail() });
    const user = userEvent.setup();
    await renderApp(`/notes/${NOTE_ID}`);
    expect(
      await screen.findByText(
        'Awaiting approval: stage 1 of 2 (Editor review)',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Requested by Maya Patel/)).toBeVisible();
    expect(
      api.listQueries.some(
        (q) => q.get('subject') === 'Note' && q.get('recordId') === NOTE_ID,
      ),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved.')).toBeVisible();
    expect(api.decisions[0]!.path).toBe('approve');
  });

  it('shows the status without actions to someone who cannot decide', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    useApprovalsApi({
      request: detail({
        can: { decide: false, cancel: false, resubmit: false },
      }),
    });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(await screen.findByText(/Awaiting approval/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  });

  it('shows nothing when the record has no open approval', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    useApprovalsApi();
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    expect(screen.queryByText(/Awaiting approval/)).not.toBeInTheDocument();
  });
});
