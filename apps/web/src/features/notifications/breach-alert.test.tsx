import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
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

const breached = (extra: object = {}) => ({
  id: 'breach-1',
  type: 'security.passwordBreached',
  title: 'Your password appeared in a data breach',
  body: 'The password you signed in with (from 203.0.113.9) appears in a known data breach.',
  data: { at: '2026-10-20T08:00:00.000Z', ip: '203.0.113.9' },
  link: null,
  key: null,
  count: 1,
  read: false,
  readAt: null,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  ...extra,
});

/** A server-side store, so a mark-read changes what the refetch brings. */
function api(
  options: {
    items?: ReturnType<typeof breached>[];
    realtime?: boolean;
    impersonating?: boolean;
    /** Answer every list request with all items, whatever it filters by. */
    ignoreFilters?: boolean;
    failRead?: boolean;
  } = {},
) {
  const state = {
    items: options.items ?? [breached()],
    readCalls: [] as string[],
    listQueries: [] as string[],
    unreadCalls: 0,
    changeBody: undefined as unknown,
  };
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
      return HttpResponse.json({
        unread: state.items.filter((entry) => !entry.read).length,
      });
    }),
    http.get('/v1/notifications', ({ request }) => {
      const url = new URL(request.url);
      state.listQueries.push(url.search);
      const read = url.searchParams.get('read');
      const type = url.searchParams.get('type');
      const items = state.items.filter(
        (entry) =>
          options.ignoreFilters ||
          ((read === null || String(entry.read) === read) &&
            (type === null || entry.type === type)),
      );
      return HttpResponse.json({ items, nextCursor: null });
    }),
    http.get('/v1/notifications/types', () =>
      HttpResponse.json({
        items: [
          {
            type: 'security.passwordBreached',
            label: 'Password found in a data breach',
            mandatory: true,
            channels: { email: 'immediate' },
          },
        ],
      }),
    ),
    http.post('/v1/notifications/:id/read', ({ params }) => {
      const id = String(params.id);
      state.readCalls.push(id);
      if (options.failRead) {
        return problem(500, 'internal_error');
      }
      state.items = state.items.map((entry) =>
        entry.id === id ? { ...entry, read: true } : entry,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/v1/auth/password/change', async ({ request }) => {
      state.changeBody = await request.json();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const banner = () => screen.queryByRole('alert');
const bannerText = /appears in a known data breach\. Change it now/;

beforeEach(() => {
  connections.length = 0;
});

describe('the breached-password banner', () => {
  it('shows for an unread alert, asking only for that type, and links to the password change', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/');

    expect(await screen.findByText(bannerText)).toBeVisible();
    expect(state.listQueries[0]).toContain('type=security.passwordBreached');
    expect(state.listQueries[0]).toContain('read=false');

    const link = screen.getByRole('link', { name: 'Change your password' });
    expect(link).toHaveAttribute('href', '/account/security');
    await user.click(link);
    expect(
      await screen.findByRole('button', { name: 'Change the password' }),
    ).toBeVisible();
  });

  it('is not shown without an alert, or once it is read', async () => {
    // The handler hands the read item back though the request filters it
    // out: the banner must not trust the server's filter alone.
    const state = api({
      items: [breached({ read: true })],
      ignoreFilters: true,
    });
    await renderApp('/');
    await waitFor(() => expect(state.listQueries).toHaveLength(1));
    await screen.findByText('Dashboard', { selector: 'h1' });
    expect(banner()).toBeNull();
  });

  it('appears when the alert arrives over realtime and goes when it is marked read', async () => {
    const state = api({ items: [] });
    const user = userEvent.setup();
    await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    await waitFor(() => expect(state.listQueries).toHaveLength(1));
    expect(banner()).toBeNull();

    state.items = [breached()];
    act(() => connections[0]!.emit('notification', breached()));
    expect(await screen.findByText(bannerText)).toBeVisible();

    // Reading it in the bell's popover hides the banner.
    await user.click(
      await screen.findByRole('button', { name: /^Notifications, / }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Mark as read' }),
    );
    await waitFor(() => expect(state.readCalls).toEqual(['breach-1']));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('goes when the alert is read elsewhere (another tab, over the socket)', async () => {
    api();
    await renderApp('/');
    expect(await screen.findByText(bannerText)).toBeVisible();
    act(() =>
      connections[0]!.emit('notification.read', {
        id: 'breach-1',
        readAt: '2026-10-20T09:00:00.000Z',
      }),
    );
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('goes once the password is changed, marking the alert read', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/account/security');
    expect(await screen.findByText(bannerText)).toBeVisible();

    await user.type(
      screen.getByLabelText('Current password'),
      'old-password-1',
    );
    await user.type(
      screen.getByLabelText('New password'),
      'a-brand-new-passphrase',
    );
    await user.type(
      screen.getByLabelText('Confirm the password'),
      'a-brand-new-passphrase',
    );
    await user.click(
      screen.getByRole('button', { name: 'Change the password' }),
    );

    expect(await findToast(/Password changed/)).toBeVisible();
    await waitFor(() => expect(state.readCalls).toEqual(['breach-1']));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('tells the user when marking the alert read fails after a password change', async () => {
    const state = api({ failRead: true });
    const user = userEvent.setup();
    await renderApp('/account/security');
    expect(await screen.findByText(bannerText)).toBeVisible();

    await user.type(
      screen.getByLabelText('Current password'),
      'old-password-1',
    );
    await user.type(
      screen.getByLabelText('New password'),
      'a-brand-new-passphrase',
    );
    await user.type(
      screen.getByLabelText('Confirm the password'),
      'a-brand-new-passphrase',
    );
    await user.click(
      screen.getByRole('button', { name: 'Change the password' }),
    );

    expect(
      await findToast(/breach alert could not be marked as read/),
    ).toBeVisible();
    expect(state.readCalls).toEqual(['breach-1']);
    expect(banner()).not.toBeNull();
  });

  it('is not shown while an administrator acts as the user', async () => {
    const state = api({ impersonating: true });
    await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    // The bell's count was asked for: the layout's queries have run.
    await waitFor(() => expect(state.unreadCalls).toBeGreaterThan(0));
    expect(banner()).toBeNull();
    expect(state.listQueries.some((q) => q.includes('passwordBreached'))).toBe(
      false,
    );
  });
});

describe('the alert in the notification list', () => {
  it('stands out and leads to the password change', async () => {
    api({ realtime: false });
    const user = userEvent.setup();
    await renderApp('/notifications');

    const title = await screen.findByText(
      'Your password appeared in a data breach',
    );
    const row = title.closest('li')!;
    expect(row).toHaveTextContent('Change your password');
    expect(row.className).toContain('bg-destructive');

    await user.click(title);
    expect(
      await screen.findByRole('button', { name: 'Change the password' }),
    ).toBeVisible();
  });
});
