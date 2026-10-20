import { useQuery } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeProvider } from '@/lib/realtime';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { approvalQuery } from './api';
import { useApprovalCount } from './use-approval-count';

// `approval.applied` clears "approved, applying" without polling: only the
// request it names is refetched.

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

const RECORD = '0199a3f2-0000-7000-8000-000000000501';

const approval = (id: string, outcomeAppliedAt: string | null) => ({
  id,
  status: 'approved',
  title: `Request ${id}`,
  outcomeAppliedAt,
});

/** The nav's hook (it hears the events) and two requests' pages. */
function Probe() {
  useApprovalCount();
  const a = useQuery(approvalQuery('a'));
  const b = useQuery(approvalQuery('b'));
  const state = (query: typeof a) =>
    query.data
      ? query.data.approval.outcomeAppliedAt
        ? 'applied'
        : 'applying'
      : 'loading';
  return (
    <>
      <p>a: {state(a)}</p>
      <p>b: {state(b)}</p>
    </>
  );
}

describe('approval.applied', () => {
  it('refetches the request that was applied, not the others', async () => {
    const state: Record<string, ReturnType<typeof approval>> = {
      a: approval('a', null),
      b: approval('b', null),
    };
    const calls = { a: 0, b: 0 };
    server.use(
      http.get('/v1/approvals/:id', ({ params }) => {
        const id = params.id as 'a' | 'b';
        calls[id]++;
        return HttpResponse.json(state[id]);
      }),
    );
    await renderComponent(
      <RealtimeProvider>
        <Probe />
      </RealtimeProvider>,
    );
    await waitFor(() => expect(connections).toHaveLength(1));
    const fake = connections[0]!;
    act(() => fake.emit('connect'));
    expect(await screen.findByText('a: applying')).toBeVisible();
    expect(screen.getByText('b: applying')).toBeVisible();

    state.a = approval('a', '2026-10-20T09:00:00.000Z');
    state.b = approval('b', '2026-10-20T09:00:00.000Z');
    act(() =>
      fake.emit('approval.applied', {
        id: 'a',
        subject: 'TestItem',
        recordId: RECORD,
        outcomeAppliedAt: '2026-10-20T09:00:00.000Z',
      }),
    );
    expect(await screen.findByText('a: applied')).toBeVisible();
    // b was not named: it stays as it was read.
    expect(screen.getByText('b: applying')).toBeVisible();
    expect(calls).toEqual({ a: 2, b: 1 });
  });
});
