import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';
import { ApprovalBanner } from './record-banner';
import { peopleHandler } from '@/test/people';
import { expectNoToast, findToast } from '@/test/toast';
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
// The record asked about: a test-only subject's, no feature's.
const RECORD_ID = '0199a3f2-0000-7000-8000-000000000501';
const OTHER_USER = '0199a3f2-0000-7000-8000-000000000009';

const item = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  key: 'TestItem.publish',
  subject: 'TestItem',
  recordId: RECORD_ID,
  action: 'publish',
  status: 'pending',
  requester: `user:${OTHER_USER}`,
  requesterName: 'Maya Patel',
  title: 'Q3 targets',
  link: `/test-items/${RECORD_ID}`,
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
  // What the user may do, and the tag to send back: the list carries both.
  can: { decide: true, cancel: false, resubmit: false },
  etag: '"v1"',
  ...over,
});

/** A request the user may not act on (one they asked for, one that ended). */
const noActions = { decide: false, cancel: false, resubmit: false };

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
  decided?: ReturnType<typeof item>[];
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
    peopleQueries: [] as string[],
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
          : query.get('decidedByMe')
            ? (options.decided ?? [])
            : [];
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
    // Active members only, as the API gives them; the user among them.
    peopleHandler(
      [
        { id: OTHER_USER, name: 'Maya Patel' },
        { id: signedInUser.user.id, name: 'Ada' },
      ],
      state.peopleQueries,
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
        subject: 'TestItem',
        recordId: RECORD_ID,
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
    ).toHaveAttribute('href', `/test-items/${RECORD_ID}`);
    // A key with no name in approvals:actions shows as itself.
    expect(screen.getByText(/TestItem\.publish/)).toBeVisible();
    expect(screen.getByText(/Editor review \(stage 1 of 2\)/)).toBeVisible();
    expect(screen.getByText(/Requested by Maya Patel/)).toBeVisible();
  });

  it('asks the API for each tab, and offers what each row can', async () => {
    const api = useApprovalsApi({
      requested: [
        item({ id: 'r', title: 'Mine', status: 'approved', can: noActions }),
      ],
      decided: [
        item({ id: 'e', title: 'Old', status: 'rejected', can: noActions }),
      ],
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
    // What I decided, not every request that ended.
    expect(api.listQueries.some((q) => q.get('decidedByMe') === 'true')).toBe(
      true,
    );
    expect(api.listQueries.some((q) => q.has('status.in'))).toBe(false);
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  });

  it('says so when the user decided nothing yet', async () => {
    useApprovalsApi();
    await renderApp('/approvals?tab=history');
    expect(
      await screen.findByText('You have not decided any approval yet.'),
    ).toBeVisible();
  });

  it('shows only the decisions a row can, in any tab', async () => {
    const api = useApprovalsApi({
      waiting: [
        item({ id: 'a', title: 'Decidable' }),
        item({ id: 'b', title: 'Not mine to decide', can: noActions }),
      ],
      requested: [
        item({
          id: 'c',
          title: 'Asked by me',
          can: { decide: false, cancel: true, resubmit: false },
          etag: '"v7"',
        }),
      ],
    });
    const user = userEvent.setup();
    await renderApp('/approvals');
    const list = await screen.findByRole('list', {
      name: 'Waiting for me',
    });
    const rows = within(list).getAllByRole('listitem');
    expect(
      within(rows[0]!).getByRole('button', { name: 'Approve' }),
    ).toBeVisible();
    expect(
      within(rows[0]!).queryByRole('button', { name: 'Cancel request' }),
    ).not.toBeInTheDocument();
    expect(
      within(rows[1]!).queryByRole('button', { name: /Approve|Reject|Cancel/ }),
    ).not.toBeInTheDocument();

    // The requester cancels from their tab, with that row's ETag.
    await user.click(screen.getByRole('tab', { name: 'Requested by me' }));
    await screen.findByText('Asked by me');
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel request' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Cancel request' }),
    );
    await findToast('Request cancelled.');
    expect(api.decisions).toEqual([
      { path: 'cancel', body: {}, ifMatch: '"v7"' },
    ]);
  });

  it('tells the user a row changed since the list was read (412), and reloads it', async () => {
    const api = useApprovalsApi();
    server.use(
      http.post('/v1/approvals/:id/approve', () =>
        problem(412, 'precondition_failed'),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    const before = api.listQueries.filter((q) => q.get('assignedToMe')).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await within(dialog).findByText('This request changed'),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        api.listQueries.filter((q) => q.get('assignedToMe')).length,
      ).toBeGreaterThan(before),
    );
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
      { path: 'approve', body: { comment: 'Looks good' }, ifMatch: '"v1"' },
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
      { path: 'reject', body: { comment: 'Not yet' }, ifMatch: '"v1"' },
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
    const person = await within(dialog).findByRole('combobox', {
      name: 'Delegate to',
    });
    // Searched as typed among the people any member may see (not the access
    // directory), never yourself. (Dice UI takes the text a frame later:
    // typed at once, not key by key.)
    await user.click(person);
    expect(
      await screen.findByRole('option', { name: 'Maya Patel' }),
    ).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Ada' })).toBeNull();
    fireEvent.change(person, { target: { value: 'ma' } });
    await waitFor(() => expect(api.peopleQueries).toContain('ma'));
    await user.click(await screen.findByRole('option', { name: 'Maya Patel' }));
    fireEvent.change(within(dialog).getByLabelText('From'), {
      target: { value: '2026-11-01T09:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Until'), {
      target: { value: '2026-11-08T09:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    await findToast('Delegation created.');
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
    await user.click(await screen.findByRole('option', { name: /Maya Patel/ }));
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
    await findToast('Approved.');
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

  it('asks for changes with the reason, with the ETag it read', async () => {
    const api = useApprovalsApi();
    const user = userEvent.setup();
    await renderApp(`/approvals/${REQUEST_ID}`);
    await user.click(
      await screen.findByRole('button', { name: 'Request changes' }),
    );
    const dialog = await screen.findByRole('dialog');
    // The requester needs to know what to change.
    await user.click(
      within(dialog).getByRole('button', { name: 'Request changes' }),
    );
    expect(
      await within(dialog).findByText('Say what should change.'),
    ).toBeVisible();
    expect(api.decisions).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox'), 'Fix the title');
    await user.click(
      within(dialog).getByRole('button', { name: 'Request changes' }),
    );
    await findToast('Changes requested.');
    expect(api.decisions).toEqual([
      {
        path: 'request-changes',
        body: { comment: 'Fix the title' },
        ifMatch: '"v1"',
      },
    ]);
  });

  it('offers no request for changes to someone who may not decide', async () => {
    useApprovalsApi({
      request: detail({ can: noActions }),
    });
    await renderApp(`/approvals/${REQUEST_ID}`);
    await screen.findByRole('heading', { name: 'Q3 targets' });
    expect(
      screen.queryByRole('button', { name: 'Request changes' }),
    ).not.toBeInTheDocument();
  });

  it('lets the requester resubmit after changes were requested', async () => {
    const api = useApprovalsApi({
      request: detail({
        status: 'changes_requested',
        can: { decide: false, cancel: true, resubmit: true },
      }),
    });
    const user = userEvent.setup();
    await renderApp(`/approvals/${REQUEST_ID}`);
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Resubmit' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Fixed');
    await user.click(within(dialog).getByRole('button', { name: 'Resubmit' }));
    await findToast('Resubmitted.');
    expect(api.decisions).toEqual([
      { path: 'resubmit', body: { comment: 'Fixed' }, ifMatch: '"v1"' },
    ]);
  });

  it('resubmits without a comment', async () => {
    const api = useApprovalsApi({
      request: detail({
        status: 'changes_requested',
        can: { decide: false, cancel: false, resubmit: true },
      }),
    });
    const user = userEvent.setup();
    await renderApp(`/approvals/${REQUEST_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Resubmit' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Resubmit' }));
    await findToast('Resubmitted.');
    expect(api.decisions[0]).toMatchObject({ path: 'resubmit', body: {} });
  });

  describe('abandoning an approved request that was never applied', () => {
    const stuck = (over: Record<string, unknown> = {}) =>
      detail({
        status: 'approved',
        outcomeAppliedAt: null,
        can: noActions,
        ...over,
      });

    it('is offered to an administrator who manages approvals', async () => {
      const api = useApprovalsApi({
        request: stuck(),
        can: { 'Approval.manage': true },
      });
      const user = userEvent.setup();
      await renderApp(`/approvals/${REQUEST_ID}`);
      await user.click(await screen.findByRole('button', { name: 'Abandon' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByRole('textbox'), 'Workflow lost');
      await user.click(within(dialog).getByRole('button', { name: 'Abandon' }));
      await findToast('Request abandoned.');
      expect(api.decisions).toEqual([
        {
          path: 'abandon',
          body: { reason: 'Workflow lost' },
          ifMatch: '"v1"',
        },
      ]);
    });

    it('tells the administrator when the outcome is still being applied (409)', async () => {
      useApprovalsApi({
        request: stuck(),
        can: { 'Approval.manage': true },
      });
      server.use(
        http.post('/v1/approvals/:id/abandon', () =>
          problem(409, 'approval_not_stuck'),
        ),
      );
      const user = userEvent.setup();
      await renderApp(`/approvals/${REQUEST_ID}`);
      await user.click(await screen.findByRole('button', { name: 'Abandon' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Abandon' }));
      expect(
        await within(dialog).findByText('approval_not_stuck (test)'),
      ).toBeVisible();
    });

    it('is not offered without Approval.manage', async () => {
      useApprovalsApi({ request: stuck() });
      await renderApp(`/approvals/${REQUEST_ID}`);
      await screen.findByRole('heading', { name: 'Q3 targets' });
      expect(
        screen.queryByRole('button', { name: 'Abandon' }),
      ).not.toBeInTheDocument();
    });

    it('is not offered once the outcome was applied, or while the request is open', async () => {
      useApprovalsApi({
        request: stuck({ outcomeAppliedAt: '2026-10-17T09:00:00.000Z' }),
        can: { 'Approval.manage': true },
      });
      await renderApp(`/approvals/${REQUEST_ID}`);
      await screen.findByRole('heading', { name: 'Q3 targets' });
      expect(
        screen.queryByRole('button', { name: 'Abandon' }),
      ).not.toBeInTheDocument();
    });

    it('waits a while after the approval, while its outcome is being applied', async () => {
      const now = new Date().toISOString();
      useApprovalsApi({
        request: stuck({ updatedAt: now, endedAt: now }),
        can: { 'Approval.manage': true },
      });
      await renderApp(`/approvals/${REQUEST_ID}`);
      await screen.findByRole('heading', { name: 'Q3 targets' });
      expect(
        screen.queryByRole('button', { name: 'Abandon' }),
      ).not.toBeInTheDocument();
    });

    it('is not offered for a pending request', async () => {
      useApprovalsApi({
        request: stuck({ status: 'pending' }),
        can: { 'Approval.manage': true },
      });
      await renderApp(`/approvals/${REQUEST_ID}`);
      await screen.findByRole('heading', { name: 'Q3 targets' });
      expect(
        screen.queryByRole('button', { name: 'Abandon' }),
      ).not.toBeInTheDocument();
    });
  });

  it('shows a not-found state', async () => {
    useApprovalsApi();
    server.use(http.get('/v1/approvals/:id', () => problem(404, 'not_found')));
    await renderApp(`/approvals/${REQUEST_ID}`);
    expect(await screen.findByText('Approval not found')).toBeVisible();
    // The page says it: not a toast as well.
    await expectNoToast();
  });
});

describe('the banner on a record', () => {
  // As a record's page shows it, for a test-only subject's record.
  const renderBanner = () =>
    renderComponent(
      <ApprovalBanner subject="TestItem" recordId={RECORD_ID} />,
      { can: ['TestItem.read'] },
    );

  it('shows the open approval and lets an approver decide', async () => {
    const api = useApprovalsApi({ request: detail() });
    const user = userEvent.setup();
    await renderBanner();
    expect(
      await screen.findByText(
        'Awaiting approval: stage 1 of 2 (Editor review)',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Requested by Maya Patel/)).toBeVisible();
    expect(
      api.listQueries.some(
        (q) =>
          q.get('subject') === 'TestItem' && q.get('recordId') === RECORD_ID,
      ),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await findToast('Approved.');
    expect(api.decisions[0]!.path).toBe('approve');
  });

  it('shows the status without actions to someone who cannot decide', async () => {
    useApprovalsApi({
      request: detail({
        can: { decide: false, cancel: false, resubmit: false },
      }),
    });
    await renderBanner();
    expect(await screen.findByText(/Awaiting approval/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  });

  it('shows nothing when the record has no open approval', async () => {
    const api = useApprovalsApi();
    await renderBanner();
    // Asked, and answered with nothing.
    await waitFor(() =>
      expect(api.listQueries.some((q) => q.get('recordId') === RECORD_ID)).toBe(
        true,
      ),
    );
    expect(screen.queryByText(/Awaiting approval/)).not.toBeInTheDocument();
  });
});
