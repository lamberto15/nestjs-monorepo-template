import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderApp } from '@/test/render-app';
import { allFeatures, server, signedInUser } from '@/test/server';
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

const item = (id: string, extra: object = {}) => ({
  id,
  type: 'note.published',
  title: `Title ${id}`,
  body: `Body ${id}`,
  data: {},
  link: null,
  key: null,
  count: 1,
  read: false,
  readAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  ...extra,
});

/** A server-side store the handlers read, so a mutation changes what a refetch brings. */
function api(options: { realtime?: boolean; impersonating?: boolean } = {}) {
  const state = {
    items: [item('a'), item('b', { link: '/notes' })],
    unreadCalls: 0,
    listCalls: 0,
    readCalls: [] as string[],
    readAllCalls: 0,
    preferencesBody: undefined as unknown,
  };
  const unread = () => state.items.filter((entry) => !entry.read).length;
  const user = options.impersonating
    ? {
        ...signedInUser.user,
        impersonator: { id: 'admin', email: 'admin@example.com' },
      }
    : signedInUser.user;
  server.use(
    http.get('/v1/auth/me', () => HttpResponse.json({ ...signedInUser, user })),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: options.realtime ?? true }),
    ),
    http.get('/v1/notifications/unread-count', () => {
      state.unreadCalls++;
      return HttpResponse.json({ unread: unread() });
    }),
    http.get('/v1/notifications', ({ request }) => {
      state.listCalls++;
      const read = new URL(request.url).searchParams.get('read');
      const items = state.items.filter(
        (entry) => read === null || String(entry.read) === read,
      );
      return HttpResponse.json({ items, nextCursor: null });
    }),
    http.post('/v1/notifications/read-all', () => {
      state.readAllCalls++;
      state.items = state.items.map((entry) => ({ ...entry, read: true }));
      return HttpResponse.json({ updated: 2 });
    }),
    http.post('/v1/notifications/:id/read', ({ params }) => {
      const id = String(params.id);
      state.readCalls.push(id);
      state.items = state.items.map((entry) =>
        entry.id === id ? { ...entry, read: true } : entry,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/v1/notifications/types', () =>
      HttpResponse.json({
        items: [
          {
            type: 'note.published',
            label: 'Note published',
            mandatory: false,
            channels: { email: 'immediate' },
          },
          {
            type: 'security.newSignIn',
            label: 'New sign-in',
            mandatory: true,
            channels: { email: 'immediate' },
          },
        ],
      }),
    ),
    http.get('/v1/notifications/preferences', () =>
      HttpResponse.json({
        types: {
          'note.published': { email: 'immediate' },
          'security.newSignIn': { email: 'immediate' },
        },
      }),
    ),
    http.put('/v1/notifications/preferences', async ({ request }) => {
      state.preferencesBody = await request.json();
      return HttpResponse.json({
        types: {
          'note.published': { email: 'daily' },
          'security.newSignIn': { email: 'immediate' },
        },
      });
    }),
  );
  return state;
}

const bell = () => screen.findByRole('button', { name: /^Notifications, / });
const bellWith = (unread: number) =>
  screen.findByRole('button', { name: `Notifications, ${unread} unread` });

beforeEach(() => {
  connections.length = 0;
});

// The popover's rows are read on /approvals: the home page lists the unread
// notifications itself (the dashboard's card), which would match the same texts.
describe('the bell and realtime', () => {
  it('shows the unread count and follows the socket', async () => {
    api();
    await renderApp('/');
    expect(await bellWith(2)).toBeVisible();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.connects).toBe(1);

    act(() =>
      connections[0]!.emit('notifications.unread-count', { unread: 7 }),
    );
    expect(await bellWith(7)).toBeVisible();
  });

  it('puts a new notification on top of the popover', async () => {
    api();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await bell());
    expect(await screen.findByText('Title a')).toBeVisible();

    act(() =>
      connections[0]!.emit('notification', item('c', { title: 'Fresh' })),
    );
    expect(await screen.findByText('Fresh')).toBeVisible();
  });

  it('coalesces list refreshes for notification bursts, then refreshes a later event', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/');
    await waitFor(() => expect(state.listCalls).toBeGreaterThan(0));
    await user.click(await bell());
    await screen.findAllByText('Title a');
    const initialCalls = state.listCalls;

    act(() => {
      connections[0]!.emit('notification', item('c'));
      connections[0]!.emit('notification', item('d'));
      connections[0]!.emit('notification', item('e'));
    });
    expect(await screen.findByText('Title c')).toBeVisible();
    expect(state.listCalls).toBe(initialCalls);
    // Dashboard and breach alert are both active list queries.
    await waitFor(() => expect(state.listCalls).toBe(initialCalls + 2), {
      timeout: 2_000,
    });

    act(() => connections[0]!.emit('notification', item('f')));
    await waitFor(() => expect(state.listCalls).toBe(initialCalls + 4), {
      timeout: 2_000,
    });
  });

  it('refetches after a reconnect, not at the first connection', async () => {
    const state = api();
    await renderApp('/');
    // The bell shows before the count arrives: wait for the count, which is
    // the first unread-count request answered.
    await bellWith(2);
    expect(state.unreadCalls).toBe(1);

    act(() => connections[0]!.emit('connect'));
    await waitFor(() => expect(state.unreadCalls).toBe(1));
    act(() => connections[0]!.emit('connect'));
    await waitFor(() => expect(state.unreadCalls).toBe(2));
  });

  it('closes the socket and opens another when the session changes', async () => {
    api();
    const { queryClient } = await renderApp('/');
    await bell();
    act(() => {
      queryClient.setQueryData(['auth', 'me'], {
        ...signedInUser,
        tenant: { ...signedInUser.tenant!, id: 'other' },
      });
    });
    await waitFor(() => expect(connections).toHaveLength(2));
    expect(connections[0]!.closed).toBe(true);
    expect(connections[1]!.closed).toBe(false);
  });

  it('marks one read and all read, in the cache', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await bell());
    const row = (await screen.findByText('Title a')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(state.readCalls).toEqual(['a']));
    await waitFor(() =>
      expect(within(row).queryByRole('img', { name: 'Unread' })).toBeNull(),
    );
    expect(await bellWith(1)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(state.readAllCalls).toBe(1));
    expect(await bellWith(0)).toBeVisible();
    expect(screen.queryAllByRole('img', { name: 'Unread' })).toHaveLength(0);
  });

  it('offers no changes while impersonating', async () => {
    api({ impersonating: true });
    const user = userEvent.setup();
    await renderApp('/approvals');
    await user.click(await bell());
    await screen.findByText('Title a');
    expect(
      screen.queryByRole('button', { name: 'Mark all as read' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull();
  });
});

describe('without realtime', () => {
  it('has no bell and no socket, and the inbox polls every 60 seconds', async () => {
    api({ realtime: false });
    const { queryClient } = await renderApp('/notifications');
    expect(await screen.findByText('Title a')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^Notifications, / }),
    ).toBeNull();
    expect(connections).toHaveLength(0);
    const count = queryClient
      .getQueryCache()
      .find({ queryKey: ['notifications', 'unread'] });
    expect(count?.observers[0]?.options.refetchInterval).toBe(60_000);
  });
});

describe('the inbox', () => {
  it('removes one', async () => {
    const state = api();
    server.use(
      // The store forgets it, as the API does: the refetch after the delete
      // must not bring it back.
      http.delete('/v1/notifications/:id', ({ params }) => {
        state.items = state.items.filter((entry) => entry.id !== params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/notifications');
    const row = (await screen.findByText('Title b')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Title b')).toBeNull());
  });
});

describe('preferences', () => {
  it('saves what differs from the defaults, and locks mandatory types', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/account/notifications');
    await user.click(
      await screen.findByRole('combobox', { name: 'Note published: Email' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Daily digest' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(state.preferencesBody).toEqual({
        'note.published': { email: 'daily' },
      }),
    );
    await findToast('Settings saved.');

    await user.click(
      screen.getByRole('combobox', { name: 'New sign-in: Email' }),
    );
    expect(await screen.findByRole('option', { name: 'Off' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
