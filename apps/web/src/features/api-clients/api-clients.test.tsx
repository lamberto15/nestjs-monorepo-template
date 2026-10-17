import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { allFeatures, server, signedInUser } from '@/test/server';
import { rangeFor } from './usage-page';

const SECRET = 'sk_abc123_supersecretvalue';
const ROTATED = 'sk_def456_rotatedsecretvalue';

const key = (id: string, extra: object = {}) => ({
  id: `0199a3f2-0000-7000-8000-00000000k${id}`,
  keyId: `key${id}`,
  createdAt: '2026-10-10T08:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  ...extra,
});

const client = (extra: object = {}) => ({
  id: '0199a3f2-0000-7000-8000-00000000c001',
  name: 'Billing exporter',
  active: true,
  dailyQuota: 100 as number | null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  keys: [key('1', { lastUsedAt: '2026-10-16T08:00:00.000Z' })],
  roles: [],
  ...extra,
});

/** A server-side store, so a mutation changes what the refetch brings. */
function api(
  options: { features?: Partial<typeof allFeatures>; can?: boolean } = {},
) {
  const state = {
    clients: [client()],
    created: undefined as unknown,
    rotated: undefined as unknown,
    revokedKeys: [] as string[],
    patches: [] as unknown[],
    usageQueries: [] as URLSearchParams[],
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        can: { 'Access.manageClients': options.can ?? true },
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, ...options.features }),
    ),
    http.get('/v1/access/clients', () =>
      HttpResponse.json({ items: state.clients }),
    ),
    http.post('/v1/access/clients', async ({ request }) => {
      state.created = await request.json();
      const created = client({
        id: '0199a3f2-0000-7000-8000-00000000c002',
        name: (state.created as { name: string }).name,
        dailyQuota: null,
        keys: [key('2')],
      });
      state.clients = [...state.clients, created];
      return HttpResponse.json({ ...created, key: SECRET }, { status: 201 });
    }),
    http.post('/v1/access/clients/:id/rotate', async ({ request }) => {
      state.rotated = await request.json();
      const [first] = state.clients;
      state.clients = [{ ...first!, keys: [...first!.keys, key('3')] }];
      return HttpResponse.json({ ...state.clients[0], key: ROTATED });
    }),
    http.patch('/v1/access/clients/:id', async ({ request }) => {
      const body = (await request.json()) as object;
      state.patches.push(body);
      state.clients = state.clients.map((entry, index) =>
        index === 0 ? { ...entry, ...body } : entry,
      );
      return HttpResponse.json(state.clients[0]);
    }),
    http.delete('/v1/access/clients/:id/keys/:keyId', ({ params }) => {
      state.revokedKeys.push(String(params.keyId));
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/v1/access/clients/:id/usage', ({ request }) => {
      const query = new URL(request.url).searchParams;
      state.usageQueries.push(query);
      const to = query.get('to')!;
      const from = query.get('from')!;
      const days = [];
      for (let at = Date.parse(from); at <= Date.parse(to); at += 86_400_000) {
        const day = new Date(at).toISOString().slice(0, 10);
        days.push(
          day === to
            ? {
                day,
                total: 40,
                routes: { 'GET /v1/notes': 30, 'POST /v1/notes': 10 },
              }
            : { day, total: 0, routes: {} },
        );
      }
      return HttpResponse.json({ from, to, days, total: 40 });
    }),
  );
  return state;
}

const everywhere = (queryClient: {
  getQueryCache(): { getAll(): { state: { data: unknown } }[] };
  getMutationCache(): { getAll(): { state: { data: unknown } }[] };
}) =>
  JSON.stringify([
    ...queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
    ...queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
  ]);

beforeEach(() => {
  // jsdom has no ResizeObserver, which recharts' container needs.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('creating a client: the key is shown once', () => {
  it('shows the key in a dialog, and nowhere after it is closed', async () => {
    const state = api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp('/api-clients');
    expect(await screen.findByText('Billing exporter')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'New client' }));
    await user.type(screen.getByLabelText('Name'), 'Mail relay');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Copy the key of Mail relay',
    });
    expect(within(dialog).getByLabelText('API key')).toHaveTextContent(SECRET);
    expect(dialog).toHaveTextContent("You won't see this key again");
    expect(state.created).toEqual({ name: 'Mail relay' });

    await user.click(
      within(dialog).getByRole('button', { name: 'I have copied it' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body).not.toHaveTextContent(SECRET);
    // Not in the query cache, not in the mutation cache.
    expect(everywhere(queryClient)).not.toContain(SECRET);
    // The new client is in the refreshed list, without a key.
    expect(await screen.findByText('Mail relay')).toBeVisible();
  });

  it('does not keep the key in the caches while the dialog is still open', async () => {
    api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp('/api-clients');
    await screen.findByText('Billing exporter');
    await user.click(screen.getByRole('button', { name: 'New client' }));
    await user.type(screen.getByLabelText('Name'), 'Mail relay');
    await user.click(screen.getByRole('button', { name: 'Create client' }));
    await screen.findByRole('dialog', { name: 'Copy the key of Mail relay' });
    // Only the observed mutation holds it (gcTime 0): none of the queries.
    const queries = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
    expect(queries).not.toContain(SECRET);
  });

  it('sends the quota in a second request, when one is typed', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/api-clients');
    await screen.findByText('Billing exporter');
    await user.click(screen.getByRole('button', { name: 'New client' }));
    await user.type(screen.getByLabelText('Name'), 'Mail relay');
    await user.type(screen.getByLabelText(/Daily quota/), '250');
    await user.click(screen.getByRole('button', { name: 'Create client' }));
    await screen.findByRole('dialog', { name: 'Copy the key of Mail relay' });
    expect(state.patches).toEqual([{ dailyQuota: 250 }]);
  });
});

describe('a client', () => {
  const path = '/api-clients/0199a3f2-0000-7000-8000-00000000c001';

  it('rotates the key and shows the new one once', async () => {
    const state = api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp(path);
    await screen.findByRole('heading', { name: 'Billing exporter' });

    await user.click(screen.getByRole('button', { name: 'Rotate key' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Rotate the key of Billing exporter?');
    expect(state.rotated).toBeUndefined();
    await user.click(
      within(confirm).getByRole('button', { name: 'Rotate key' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Copy the new key of Billing exporter',
    });
    expect(within(dialog).getByLabelText('API key')).toHaveTextContent(ROTATED);
    expect(state.rotated).toEqual({ graceSeconds: 0 });

    await user.click(
      within(dialog).getByRole('button', { name: 'I have copied it' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body).not.toHaveTextContent(ROTATED);
    expect(everywhere(queryClient)).not.toContain(ROTATED);
  });

  it('asks before revoking a key, and does nothing on cancel', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(path);
    await screen.findByRole('heading', { name: 'Billing exporter' });
    expect(screen.getByText('key1')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('The key key1 stops working now');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.revokedKeys).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke key',
      }),
    );
    await waitFor(() =>
      expect(state.revokedKeys).toEqual(['0199a3f2-0000-7000-8000-00000000k1']),
    );
  });

  it('asks before revoking the client, then deactivates it', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(path);
    await screen.findByRole('heading', { name: 'Billing exporter' });
    await user.click(screen.getByRole('button', { name: 'Revoke client' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(state.patches).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(state.patches).toEqual([{ active: false }]));
    expect(
      await screen.findByRole('button', { name: 'Reactivate client' }),
    ).toBeVisible();
  });

  it('saves and removes the quota', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(path);
    const input = await screen.findByLabelText('Requests a day');
    expect(input).toHaveValue('100');
    await user.clear(input);
    await user.type(input, '500');
    await user.click(screen.getByRole('button', { name: 'Save quota' }));
    await waitFor(() => expect(state.patches).toEqual([{ dailyQuota: 500 }]));
    await user.clear(screen.getByLabelText('Requests a day'));
    await user.click(screen.getByRole('button', { name: 'Save quota' }));
    await waitFor(() =>
      expect(state.patches.at(-1)).toEqual({ dailyQuota: null }),
    );
  });
});

describe('usage', () => {
  it('shows today against the quota, the daily chart and the routes', async () => {
    const state = api();
    await renderApp('/api-clients/usage');
    expect(await screen.findByText('60 left today')).toBeVisible();
    expect(screen.getByText('40 of 100 used')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Requests per day' }),
    ).toBeVisible();
    expect(document.querySelector('[data-slot="chart"]')).not.toBeNull();

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('GET /v1/notes');
    expect(rows[1]).toHaveTextContent('30');
    expect(rows[1]).toHaveTextContent('75%');
    expect(rows[2]).toHaveTextContent('POST /v1/notes');
    const query = state.usageQueries[0]!;
    expect({ from: query.get('from'), to: query.get('to') }).toEqual(
      rangeFor('30'),
    );
  });

  it('says so when the quota is used up', async () => {
    const state = api();
    state.clients = [client({ dailyQuota: 40 })];
    await renderApp('/api-clients/usage');
    expect(await screen.findByText(/Quota reached/)).toBeVisible();
  });

  it('counts the period back from today, both ends included', () => {
    expect(rangeFor('7', new Date('2026-10-17T10:00:00Z'))).toEqual({
      from: '2026-10-11',
      to: '2026-10-17',
    });
  });
});

describe('gating', () => {
  it('shows both entries and both pages when the switches are on', async () => {
    api();
    await renderApp('/api-clients');
    expect(
      await screen.findByRole('link', { name: 'API clients' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'API usage' })).toBeVisible();
  });

  it('has no entry and no route with apiClients off', async () => {
    api({ features: { apiClients: false } });
    await renderApp('/api-clients');
    expect(await screen.findByText('Page not found')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'API clients' })).toBeNull();
  });

  it('has no usage entry and no usage route with usage off', async () => {
    api({ features: { usage: false } });
    await renderApp('/api-clients/usage');
    expect(await screen.findByText('Page not found')).toBeVisible();
  });

  it('keeps the clients and hides the usage entry with usage off', async () => {
    api({ features: { usage: false } });
    await renderApp('/api-clients');
    expect(
      await screen.findByRole('link', { name: 'API clients' }),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'API usage' })).toBeNull();
    // The client's page no longer links to its usage.
    await userEvent.click(
      await screen.findByRole('link', { name: 'Billing exporter' }),
    );
    await screen.findByRole('heading', { name: 'Billing exporter' });
    expect(screen.queryByRole('link', { name: 'View usage' })).toBeNull();
  });

  it('hides the entries from a user without the permission', async () => {
    api({ can: false });
    await renderApp('/api-clients');
    await screen.findByRole('heading', { name: 'API clients' });
    expect(screen.queryByRole('link', { name: 'API usage' })).toBeNull();
  });
});
