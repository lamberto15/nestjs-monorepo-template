import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';
import { MAX_EVENTS } from './use-ops-events';

/** The browser's EventSource, held by the test: it pushes events and failures. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: unknown) {
    this.onmessage?.(
      new MessageEvent('message', {
        data: typeof data === 'string' ? data : JSON.stringify(data),
      }),
    );
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

const original = globalThis.EventSource;
afterEach(() => {
  FakeEventSource.instances = [];
  globalThis.EventSource = original;
});

const queue = (name: string, failed: number) => ({
  name,
  paused: false,
  counts: { waiting: 1, active: 2, delayed: 3, completed: 40, failed },
  recentFailures: failed
    ? [
        {
          id: '7',
          name: 'send',
          attempts: 3,
          reason: '<b>boom</b>',
          failedAt: '2026-10-20T08:00:00.000Z',
        },
      ]
    : [],
});

const letter = (id: string, topic: string) => ({
  id,
  topic,
  key: null,
  attempts: 5,
  lastError: 'upstream 503',
  reason: 'exhausted',
  createdAt: Date.parse('2026-10-20T07:00:00.000Z'),
  failedAt: Date.parse('2026-10-20T08:00:00.000Z'),
});

function api(
  options: { operator?: boolean; view?: boolean; manage?: boolean } = {},
) {
  const state = {
    asked: 0,
    outboxReads: 0,
    retried: [] as string[],
    requeued: [] as unknown[],
    purged: [] as unknown[],
    letters: [letter('d1', 'orders.created'), letter('d2', 'mail.send')],
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        tenant: { ...signedInUser.tenant!, operator: options.operator ?? true },
        can: {
          'Ops.view': options.view ?? true,
          'Ops.manage': options.manage ?? true,
        },
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/ops/queues', () => {
      state.asked += 1;
      return HttpResponse.json({
        items: [queue('mail', 2), queue('bulk', 0)],
      });
    }),
    http.post('/v1/ops/queues/:name/retry-failed', ({ params }) => {
      state.retried.push(String(params.name));
      return HttpResponse.json({ retried: 2 });
    }),
    http.get('/v1/ops/outbox', () => {
      state.asked += 1;
      state.outboxReads += 1;
      return HttpResponse.json({
        stats: {
          pending: 4,
          ready: 3,
          leased: 1,
          deadLetters: state.letters.length,
          oldestDueAt: null,
          lagMs: 4200,
          inFlight: 1,
        },
        deadLetters: state.letters,
        notifications: { undelivered: 6, undeliveredCapped: false },
        canManage: true,
      });
    }),
    http.post('/v1/ops/dead-letters/requeue', async ({ request }) => {
      const body = (await request.json()) as { ids?: string[] };
      state.requeued.push(body);
      return HttpResponse.json({ requeued: body.ids?.length ?? 2 });
    }),
    http.post('/v1/ops/dead-letters/purge', async ({ request }) => {
      const body = (await request.json()) as { ids?: string[] };
      state.purged.push(body);
      state.letters = body.ids
        ? state.letters.filter((l) => !body.ids!.includes(l.id))
        : [];
      return HttpResponse.json({ purged: body.ids?.length ?? 2 });
    }),
  );
  return state;
}

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole('tab', { name }));
}

describe('queues', () => {
  it('lists the queues with their counts and failures, as text', async () => {
    api();
    await renderApp('/ops');
    const table = (await screen.findAllByRole('table'))[0]!;
    expect(within(table).getByText('mail')).toBeInTheDocument();
    expect(within(table).getAllByText('40', { selector: 'td' })).toHaveLength(
      2,
    );
    // A job's error text is never markup.
    expect(await screen.findByText('<b>boom</b>')).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Operations' }),
    ).toHaveAttribute('href', '/ops');
  });

  it('retries the failed jobs of a queue after asking', async () => {
    const state = api();
    await renderApp('/ops');
    // Only the queue with failures offers it.
    await userEvent.click(
      await screen.findByRole('button', { name: 'Retry failed' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(state.retried).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Retry failed' }),
    );
    await waitFor(() => expect(state.retried).toEqual(['mail']));
    expect(await findToast('2 jobs put back in the queue.')).toBeVisible();
  });

  it('offers no retry without Ops.manage', async () => {
    api({ manage: false });
    await renderApp('/ops');
    await screen.findByText('mail');
    expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull();
  });
});

describe('outbox', () => {
  it('shows the counters and the dead letters', async () => {
    api();
    await renderApp('/ops');
    await openTab('Outbox');
    expect(await screen.findByText('4.2 s')).toBeInTheDocument();
    expect(screen.getByText('Undelivered notifications')).toBeInTheDocument();
    expect(await screen.findByText('orders.created')).toBeInTheDocument();
    expect(screen.getByText('mail.send')).toBeInTheDocument();
  });

  it('reads the counts again when a for-all dialog opens', async () => {
    const state = api();
    await renderApp('/ops');
    await openTab('Outbox');
    await screen.findByText('orders.created');
    const before = state.outboxReads;
    await userEvent.click(screen.getByRole('button', { name: 'Purge all' }));
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(state.outboxReads).toBeGreaterThan(before));
  });

  it('requeues one dead letter by id', async () => {
    const state = api();
    await renderApp('/ops');
    await openTab('Outbox');
    const row = (await screen.findByText('orders.created')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Requeue' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Requeue' }),
    );
    await waitFor(() => expect(state.requeued).toEqual([{ ids: ['d1'] }]));
    expect(await findToast('1 dead letter requeued.')).toBeVisible();
  });

  it('purges only after the confirmation, and cancelling sends nothing', async () => {
    const state = api();
    await renderApp('/ops');
    await openTab('Outbox');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Purge all' }),
    );
    let dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        /All dead letters \(currently 2\) are deleted for good/,
      ),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.purged).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Purge all' }));
    dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Purge all' }),
    );
    // All of them: no ids.
    await waitFor(() => expect(state.purged).toEqual([{}]));
    expect(await findToast('2 dead letters deleted.')).toBeVisible();
    expect(await screen.findByText('No dead letters.')).toBeVisible();
  });

  it('purges one dead letter by id after the confirmation', async () => {
    const state = api();
    await renderApp('/ops');
    await openTab('Outbox');
    const row = (await screen.findByText('mail.send')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Purge' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Purge' }),
    );
    await waitFor(() => expect(state.purged).toEqual([{ ids: ['d2'] }]));
  });

  it('shows the API refusal', async () => {
    api();
    server.use(http.get('/v1/ops/outbox', () => problem(500, 'internal')));
    await renderApp('/ops');
    await openTab('Outbox');
    expect(await screen.findByText('internal (test)')).toBeInTheDocument();
  });
});

describe('live events', () => {
  async function openEvents() {
    globalThis.EventSource =
      FakeEventSource as unknown as typeof globalThis.EventSource;
    api();
    await renderApp('/ops');
    await openTab('Live events');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    return FakeEventSource.instances[0]!;
  }

  it('connects to the stream, shows events newest first, as text', async () => {
    const stream = await openEvents();
    expect(stream.url).toBe('/v1/ops/events');
    expect(screen.getByTestId('stream-status')).toHaveTextContent('Connecting');
    act(() => stream.open());
    expect(screen.getByTestId('stream-status')).toHaveTextContent('Live');
    act(() => {
      stream.send({ source: 'outbox', at: Date.now(), type: 'published' });
      stream.send({
        source: 'mail',
        at: Date.now(),
        type: 'sent',
        to: '<img src=x>',
      });
      stream.send('not json');
    });
    const log = screen.getByRole('region', { name: 'Live events' });
    const items = within(log).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('mail');
    expect(items[0]).toHaveTextContent('<img src=x>');
    expect(items[1]).toHaveTextContent('published');
    expect(log.querySelector('img')).toBeNull();
  });

  it('keeps the log at its cap', async () => {
    const stream = await openEvents();
    act(() => {
      stream.open();
      for (let i = 0; i < MAX_EVENTS + 25; i++) {
        stream.send({ source: 'workflow', at: Date.now(), type: `e${i}` });
      }
    });
    const log = screen.getByRole('region', { name: 'Live events' });
    const items = within(log).getAllByRole('listitem');
    expect(items).toHaveLength(MAX_EVENTS);
    expect(items[0]).toHaveTextContent(`e${MAX_EVENTS + 24}`);
  });

  it('pauses (closing the stream), resumes and clears', async () => {
    const stream = await openEvents();
    act(() => {
      stream.open();
      stream.send({ source: 'locks', at: Date.now(), type: 'acquired' });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(stream.closed).toBe(true);
    expect(screen.getByTestId('stream-status')).toHaveTextContent(
      'Disconnected',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Live events' })).toBeNull();
  });

  it('says so when the connection drops and when it is refused', async () => {
    const stream = await openEvents();
    act(() => stream.open());
    // The browser retries a dropped connection by itself.
    act(() => stream.fail(0));
    expect(screen.getByTestId('stream-status')).toHaveTextContent('Connecting');
    // A refusal ends it for good.
    act(() => stream.fail(2));
    expect(screen.getByTestId('stream-status')).toHaveTextContent(
      'Disconnected',
    );
  });

  it('offers a new connection once the browser has given up', async () => {
    const stream = await openEvents();
    act(() => stream.open());
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    act(() => stream.fail(2));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reconnect' }),
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const next = FakeEventSource.instances[1]!;
    expect(stream.closed).toBe(true);
    act(() => next.open());
    expect(screen.getByTestId('stream-status')).toHaveTextContent('Live');
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
  });

  it('exposes the tab panel and a focusable log', async () => {
    const stream = await openEvents();
    act(() => stream.send({ source: 'mail', at: Date.now(), type: 'sent' }));
    expect(screen.getByRole('tabpanel')).toBeVisible();
    // The scroll region is named and in the tab order; the list inside keeps its role.
    const log = screen.getByRole('region', { name: 'Live events' });
    expect(log).toHaveAttribute('tabindex', '0');
    expect(within(log).getByRole('list')).toBeVisible();
  });

  it('closes the stream when leaving the tab', async () => {
    const stream = await openEvents();
    await userEvent.click(screen.getByRole('tab', { name: 'Queues' }));
    expect(stream.closed).toBe(true);
  });
});

describe('gating', () => {
  it('has no page for a tenant administrator who is no operator, and never asks', async () => {
    const state = api({ operator: false });
    await renderApp('/ops');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(state.asked).toBe(0);
  });

  it('has no menu entry for a non-operator', async () => {
    api({ operator: false });
    await renderApp('/');
    await screen.findByRole('link', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
  });

  it('has no page without Ops.view', async () => {
    const state = api({ view: false });
    await renderApp('/ops');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(state.asked).toBe(0);
  });

  it('lists the entry for operator-tenant users with the permission only', () => {
    const paths = (can: Record<string, boolean>, operatorTenant: boolean) =>
      visibleGroups(nav, allFeatures, can, false, operatorTenant)
        .flatMap((g) => g.items)
        .map((i) => i.to);
    expect(paths({ 'Ops.view': true }, true)).toContain('/ops');
    expect(paths({ 'Ops.view': true }, false)).not.toContain('/ops');
    expect(paths({}, true)).not.toContain('/ops');
  });
});
