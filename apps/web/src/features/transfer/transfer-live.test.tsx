import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBulkRun } from '@/features/bulk/use-bulk-run';
import { RealtimeProvider } from '@/lib/realtime';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { TransferStatus } from './transfer-status';
import { TransfersPage } from './transfers-page';

// Exports, imports and bulk runs follow the realtime events
// (`data.export-ready`, `data.import-finished`, `bulk.finished`): the event
// finishes the flow, the poll is only the fallback when no socket is
// connected.

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

/** Longer than the 1 s fast poll, shorter than the 30 s safety net. */
const pollsWouldHaveRun = () => new Promise((r) => setTimeout(r, 1400));

/** The socket of the mounted provider, once it made it. */
async function socket() {
  await waitFor(() => expect(connections).toHaveLength(1));
  return connections[0]!;
}
const connect = (fake: FakeRealtime) => act(() => fake.emit('connect'));

const running = (id: string, kind: 'export' | 'import' = 'export') => ({
  id,
  kind,
  name: 'test-items',
  format: 'csv',
  status: 'running',
  progress: { processed: 40 },
});
const exported = (id: string) => ({
  id,
  kind: 'export',
  name: 'test-items',
  format: 'csv',
  status: 'completed',
  progress: { processed: 3 },
  result: { rows: 3, url: `https://files.test/${id}.csv` },
});
const exportReady = (id: string) => ({
  id,
  name: 'test-items',
  rows: 3,
  url: `https://files.test/${id}.csv`,
});

type State = Record<string, Record<string, unknown>>;

/** `GET /v1/data/transfers/{id}` answers what `state[id]` holds, and counts. */
function useTransfers(state: State) {
  const calls = { get: 0 };
  server.use(
    http.get('/v1/data/transfers/:id', ({ params }) => {
      calls.get++;
      return HttpResponse.json(state[params.id as string]);
    }),
  );
  return calls;
}

function mountStatus(ids: string[]) {
  return renderComponent(
    <RealtimeProvider>
      {ids.map((id) => (
        <div key={id} data-testid={id}>
          <TransferStatus id={id} />
        </div>
      ))}
    </RealtimeProvider>,
  );
}

const download = { name: 'Download (csv)' };
const slow = { timeout: 3000 };

describe('an export or import on screen', () => {
  it('finishes on data.export-ready, without waiting for a poll', async () => {
    const state: State = { a: running('a') };
    const calls = useTransfers(state);
    await mountStatus(['a']);
    const fake = await socket();
    connect(fake);
    expect(await screen.findByText(/Working… 40 rows/)).toBeVisible();

    state.a = exported('a');
    act(() => fake.emit('data.export-ready', exportReady('a')));
    expect(await screen.findByRole('link', download)).toHaveAttribute(
      'href',
      'https://files.test/a.csv',
    );
    // The first load and the event's refetch: no poll in between.
    expect(calls.get).toBe(2);
  });

  it('finishes on data.import-finished', async () => {
    const state: State = { i: running('i', 'import') };
    useTransfers(state);
    await mountStatus(['i']);
    const fake = await socket();
    connect(fake);
    expect(await screen.findByText(/Working… 40 rows/)).toBeVisible();

    state.i = {
      ...running('i', 'import'),
      status: 'completed',
      result: { rows: 10, imported: 9, failed: 1, dryRun: false },
    };
    act(() =>
      fake.emit('data.import-finished', {
        id: 'i',
        name: 'test-items',
        rows: 10,
        imported: 9,
        failed: 1,
      }),
    );
    expect(
      await screen.findByText('10 rows read: 9 imported, 1 refused.'),
    ).toBeVisible();
  });

  it('does not poll while the socket is connected', async () => {
    const calls = useTransfers({ a: running('a') });
    await mountStatus(['a']);
    const fake = await socket();
    connect(fake);
    await screen.findByText(/Working… 40 rows/);
    const before = calls.get;
    await pollsWouldHaveRun();
    expect(calls.get).toBe(before);
  });

  it('polls again once the socket drops, and stops at the end', async () => {
    const state: State = { a: running('a') };
    const calls = useTransfers(state);
    await mountStatus(['a']);
    const fake = await socket();
    connect(fake);
    await screen.findByText(/Working… 40 rows/);

    act(() => fake.emit('disconnect'));
    state.a = exported('a');
    expect(await screen.findByRole('link', download, slow)).toBeVisible();
    const done = calls.get;
    await pollsWouldHaveRun();
    expect(calls.get).toBe(done);
  });

  it('polls while the socket has not connected yet', async () => {
    const state: State = { a: running('a') };
    useTransfers(state);
    await mountStatus(['a']);
    await screen.findByText(/Working… 40 rows/);
    // Never connected: the poll is the only way to learn.
    state.a = exported('a');
    expect(await screen.findByRole('link', download, slow)).toBeVisible();
  });

  it('ignores the events of other transfers', async () => {
    const state: State = { a: running('a'), b: running('b') };
    const calls = useTransfers(state);
    await mountStatus(['a', 'b']);
    const fake = await socket();
    connect(fake);
    await waitFor(() =>
      expect(screen.getAllByText(/Working… 40 rows/)).toHaveLength(2),
    );

    state.b = exported('b');
    const before = calls.get;
    act(() => fake.emit('data.export-ready', exportReady('b')));
    // Only b is asked for again; a stays as it was.
    expect(
      await within(screen.getByTestId('b')).findByRole('link', download),
    ).toBeVisible();
    expect(calls.get).toBe(before + 1);
    expect(
      within(screen.getByTestId('a')).getByText(/Working… 40 rows/),
    ).toBeVisible();
  });

  it('keeps asking when the event comes before the queue marks the job done', async () => {
    const state: State = { a: running('a') };
    const calls = useTransfers(state);
    await mountStatus(['a']);
    const fake = await socket();
    connect(fake);
    await screen.findByText(/Working… 40 rows/);

    // The API sends the event just before the job is completed: the refetch
    // it causes still sees `running`, and the poll finds the end.
    const before = calls.get;
    act(() => fake.emit('data.export-ready', exportReady('a')));
    await waitFor(() => expect(calls.get).toBe(before + 1));
    state.a = exported('a');
    expect(await screen.findByRole('link', download, slow)).toBeVisible();
  });

  it('refetches after a reconnect (events sent while offline are lost)', async () => {
    const state: State = { a: running('a') };
    useTransfers(state);
    await mountStatus(['a']);
    const fake = await socket();
    connect(fake);
    await screen.findByText(/Working… 40 rows/);

    act(() => fake.emit('disconnect'));
    state.a = exported('a');
    // The second 'connect': the provider refetches what was missed.
    connect(fake);
    expect(await screen.findByRole('link', download)).toBeVisible();
  });
});

describe('the list of transfers and bulk runs', () => {
  const bulkRun = (status: string) => ({
    id: 'b1',
    name: 'test-items',
    action: 'delete',
    status,
    progress: { processed: 30 },
    ...(status === 'completed' && {
      result: { done: 29, failed: 1, skipped: 0 },
    }),
  });

  function useLists(state: { bulk: ReturnType<typeof bulkRun> }) {
    const calls = { bulk: 0 };
    server.use(
      http.get('/v1/data/transfers', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/v1/bulk', () => {
        calls.bulk++;
        return HttpResponse.json({ items: [state.bulk], nextCursor: null });
      }),
    );
    return calls;
  }

  const mountPage = () =>
    renderComponent(
      <RealtimeProvider>
        <TransfersPage />
      </RealtimeProvider>,
    );

  it('shows a bulk run end on bulk.finished, and does not poll while connected', async () => {
    const state = { bulk: bulkRun('running') };
    const calls = useLists(state);
    await mountPage();
    const fake = await socket();
    connect(fake);
    expect(
      await screen.findByText('Working… 30 processed so far.'),
    ).toBeVisible();
    const before = calls.bulk;
    await pollsWouldHaveRun();
    expect(calls.bulk).toBe(before);

    state.bulk = bulkRun('completed');
    act(() =>
      fake.emit('bulk.finished', {
        id: 'b1',
        name: 'test-items',
        action: 'delete',
        done: 29,
        failed: 1,
      }),
    );
    expect(
      await screen.findByText('29 done, 1 failed, 0 skipped.'),
    ).toBeVisible();
  });

  it('polls the runs without a connected socket', async () => {
    const state = { bulk: bulkRun('running') };
    useLists(state);
    await mountPage();
    expect(
      await screen.findByText('Working… 30 processed so far.'),
    ).toBeVisible();
    state.bulk = bulkRun('completed');
    expect(
      await screen.findByText('29 done, 1 failed, 0 skipped.', {}, slow),
    ).toBeVisible();
  });
});

describe('a queued bulk run in its dialog', () => {
  function Harness() {
    // Any feature's bulk route; a test-only path, as the other tests use.
    const run = useBulkRun('/v1/test-items/bulk' as never);
    return (
      <>
        <button
          onClick={() =>
            run.start({ action: 'delete', selection: { ids: ['x'] } })
          }
        >
          Go
        </button>
        {run.dialog}
      </>
    );
  }
  const job = (status: string) => ({
    id: 'job-1',
    name: 'test-items',
    action: 'delete',
    status,
    progress:
      status === 'completed'
        ? { processed: 150, done: 149, failed: 1 }
        : { processed: 100, done: 99, failed: 1 },
    ...(status === 'completed' && {
      result: { done: 149, failed: 1, skipped: 0, results: [] },
    }),
  });

  async function start(state: { job: ReturnType<typeof job> }) {
    const calls = { get: 0 };
    server.use(
      http.post('/v1/test-items/bulk', () =>
        HttpResponse.json({ id: 'job-1', status: 'queued' }, { status: 202 }),
      ),
      http.get('/v1/bulk/:id', () => {
        calls.get++;
        return HttpResponse.json(state.job);
      }),
    );
    await renderComponent(
      <RealtimeProvider>
        <Harness />
      </RealtimeProvider>,
    );
    const fake = await socket();
    connect(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Go' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deleting' });
    expect(
      await within(dialog).findByText('100 processed: 99 done, 1 failed.'),
    ).toBeVisible();
    return { fake, calls, dialog };
  }

  const finished = (id: string) => ({
    id,
    name: 'test-items',
    action: 'delete',
    done: 149,
    failed: 1,
  });

  it('ends on bulk.finished, without a poll', async () => {
    const state = { job: job('running') };
    const { fake, calls, dialog } = await start(state);
    const before = calls.get;
    await pollsWouldHaveRun();
    expect(calls.get).toBe(before);

    state.job = job('completed');
    act(() => fake.emit('bulk.finished', finished('job-1')));
    expect(
      await within(dialog).findByText('149 done, 1 failed, 0 skipped.'),
    ).toBeVisible();
  });

  it('ignores the end of another run, and polls again when the socket drops', async () => {
    const state = { job: job('running') };
    const { fake, calls, dialog } = await start(state);
    state.job = job('completed');
    const before = calls.get;
    act(() => fake.emit('bulk.finished', finished('other-run')));
    await pollsWouldHaveRun();
    expect(calls.get).toBe(before);
    expect(
      within(dialog).getByText('100 processed: 99 done, 1 failed.'),
    ).toBeVisible();

    act(() => fake.emit('disconnect'));
    expect(
      await within(dialog).findByText(
        '149 done, 1 failed, 0 skipped.',
        {},
        slow,
      ),
    ).toBeVisible();
  });
});
