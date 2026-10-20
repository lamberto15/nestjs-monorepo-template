import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';

const entry = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `0199a3f2-0000-7000-8000-${String(n).padStart(12, '0')}`,
  address: `person${n}@example.com`,
  reason: 'hard_bounce',
  source: 'ses',
  note: null,
  lastDetail: 'General',
  events: 1,
  softBounces: 0,
  firstSeenAt: '2026-10-10T08:00:00.000Z',
  lastSeenAt: '2026-10-12T08:00:00.000Z',
  suppressedAt: '2026-10-10T08:00:00.000Z',
  skipped: 2,
  lastSkippedAt: '2026-10-11T08:00:00.000Z',
  createdBy: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...extra,
});

function api(
  options: {
    operator?: boolean;
    view?: boolean;
    manage?: boolean;
    tenancy?: 'multi' | 'single';
    entries?: ReturnType<typeof entry>[];
  } = {},
) {
  const state = {
    entries: options.entries ?? [
      entry(1),
      entry(2, { reason: 'complaint', source: 'ses' }),
      entry(3, {
        reason: 'soft_bounce',
        suppressedAt: null,
        softBounces: 2,
      }),
    ],
    queries: [] as URLSearchParams[],
    created: [] as unknown[],
    removed: [] as string[],
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        tenant: { ...signedInUser.tenant!, operator: options.operator ?? true },
        can: {
          'MailSuppression.view': options.view ?? true,
          'MailSuppression.manage': options.manage ?? true,
        },
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({
        ...allFeatures,
        realtime: false,
        tenancy: options.tenancy ?? 'multi',
      }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/mail/suppressions', ({ request }) => {
      const query = new URL(request.url).searchParams;
      state.queries.push(query);
      if (options.operator === false) {
        return problem(403, 'operator_required');
      }
      const limit = Number(query.get('limit') ?? 50);
      const page = Number(query.get('page') ?? 1);
      let rows = state.entries;
      const contains = query.get('address.contains');
      if (contains) {
        rows = rows.filter((row) => row.address.includes(contains));
      }
      const reason = query.get('reason');
      if (reason) {
        rows = rows.filter((row) => row.reason === reason);
      }
      const watching = query.get('suppressedAt.isNull');
      if (watching) {
        rows = rows.filter(
          (row) => (row.suppressedAt === null) === (watching === 'true'),
        );
      }
      const pageCount = Math.max(1, Math.ceil(rows.length / limit));
      return HttpResponse.json({
        items: rows.slice((page - 1) * limit, page * limit),
        page,
        nextPage: page < pageCount ? page + 1 : null,
        pageCount,
        total: rows.length,
        totalCapped: false,
      });
    }),
    http.get('/v1/mail/suppressions/:id', ({ params }) => {
      const found = state.entries.find((row) => row.id === params.id);
      return found ? HttpResponse.json(found) : problem(404, 'not_found');
    }),
    http.post('/v1/mail/suppressions', async ({ request }) => {
      const body = (await request.json()) as { address: string; note?: string };
      state.created.push(body);
      if (state.entries.some((row) => row.address === body.address)) {
        return problem(409, 'conflict');
      }
      const created = entry(9, {
        address: body.address,
        reason: 'manual',
        source: 'manual',
        note: body.note ?? null,
      });
      state.entries = [created, ...state.entries];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.delete('/v1/mail/suppressions/:id', ({ params }) => {
      state.removed.push(String(params.id));
      state.entries = state.entries.filter((row) => row.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

describe('mail suppressions: who sees it', () => {
  it('lists the entries and the menu links to it', async () => {
    api();
    await renderApp('/mail-suppressions');
    expect(
      await screen.findByRole('heading', { name: 'Mail suppression list' }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('person1@example.com')).toBeInTheDocument();
    expect(within(table).getByText('Complaint')).toBeInTheDocument();
    // The entry only watched for soft bounces.
    expect(within(table).getByText('Watching')).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Mail suppressions' }),
    ).toHaveAttribute('href', '/mail-suppressions');
  });

  it('is there in a single-tenant deployment too: its one tenant is the operators', async () => {
    api({ tenancy: 'single' });
    await renderApp('/mail-suppressions');
    expect(await screen.findByText('person1@example.com')).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Mail suppressions' }),
    ).toBeInTheDocument();
  });

  it('is no page for a tenant that is not the operators', async () => {
    const state = api({ operator: false });
    await renderApp('/mail-suppressions');
    expect(
      await screen.findByText(/not found|doesn.t exist/i),
    ).toBeInTheDocument();
    expect(state.queries).toHaveLength(0);
    expect(
      screen.queryByRole('link', { name: 'Mail suppressions' }),
    ).toBeNull();
  });

  it('is no page without MailSuppression.view', async () => {
    const state = api({ view: false });
    await renderApp('/mail-suppressions');
    expect(
      await screen.findByText(/not found|doesn.t exist/i),
    ).toBeInTheDocument();
    expect(state.queries).toHaveLength(0);
  });

  it('shows the API refusal when it answers operator_required anyway', async () => {
    // /me said operator, the API (a tenant deactivated meanwhile) says no.
    api();
    server.use(
      http.get('/v1/mail/suppressions', () =>
        problem(403, 'operator_required'),
      ),
    );
    await renderApp('/mail-suppressions');
    expect(
      await screen.findByText('operator_required (test)'),
    ).toBeInTheDocument();
  });

  it('hides adding and removing without MailSuppression.manage', async () => {
    api({ manage: false });
    await renderApp('/mail-suppressions');
    await screen.findByText('person1@example.com');
    expect(screen.queryByRole('button', { name: 'Add an address' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('keeps the entry out of the menu for others', () => {
    const items = (operatorTenant: boolean, can: Record<string, boolean>) =>
      visibleGroups(nav, allFeatures, can, false, operatorTenant)
        .flatMap((group) => group.items)
        .map((item) => item.to);
    const view = { 'MailSuppression.view': true };
    expect(items(true, view)).toContain('/mail-suppressions');
    expect(items(false, view)).not.toContain('/mail-suppressions');
    expect(items(true, {})).not.toContain('/mail-suppressions');
  });
});

describe('mail suppressions: filters and paging', () => {
  it('filters by address, reason and status, and sorts', async () => {
    const state = api();
    await renderApp('/mail-suppressions');
    const user = userEvent.setup();
    await screen.findByText('person1@example.com');

    await user.type(screen.getByLabelText('Address contains'), 'person2');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(state.queries.at(-1)?.get('address.contains')).toBe('person2'),
    );
    expect(await screen.findByText('person2@example.com')).toBeInTheDocument();
    expect(screen.queryByText('person1@example.com')).toBeNull();

    await user.clear(screen.getByLabelText('Address contains'));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('person1@example.com');

    await user.click(screen.getByRole('combobox', { name: 'Reason' }));
    await user.click(await screen.findByRole('option', { name: 'Complaint' }));
    await waitFor(() =>
      expect(state.queries.at(-1)?.get('reason')).toBe('complaint'),
    );
    await waitFor(() =>
      expect(screen.queryByText('person1@example.com')).toBeNull(),
    );

    await user.click(screen.getByRole('combobox', { name: 'Reason' }));
    await user.click(await screen.findByRole('option', { name: 'Any reason' }));
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Watching' }));
    await waitFor(() =>
      expect(state.queries.at(-1)?.get('suppressedAt.isNull')).toBe('true'),
    );
    expect(state.queries.at(-1)?.get('reason')).toBeNull();
    expect(await screen.findByText('person3@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(await screen.findByRole('option', { name: 'Last seen' }));
    await waitFor(() =>
      expect(state.queries.at(-1)?.get('sort')).toBe('-lastSeenAt'),
    );
  });

  it('reads the filters from the URL', async () => {
    const state = api();
    await renderApp('/mail-suppressions?reason=complaint&status=suppressed');
    expect(await screen.findByText('person2@example.com')).toBeInTheDocument();
    expect(screen.queryByText('person1@example.com')).toBeNull();
    expect(state.queries[0]?.get('suppressedAt.isNull')).toBe('false');
  });

  it('says so when nothing matches', async () => {
    api();
    await renderApp('/mail-suppressions?reason=manual');
    expect(
      await screen.findByText('No listed address matches.'),
    ).toBeInTheDocument();
  });

  it('pages by number', async () => {
    const many = Array.from({ length: 25 }, (_, i) => entry(i + 1));
    const state = api({ entries: many });
    await renderApp('/mail-suppressions');
    const user = userEvent.setup();
    expect(await screen.findByText('person1@example.com')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('person21@example.com')).toBeInTheDocument();
    expect(screen.queryByText('person1@example.com')).toBeNull();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(state.queries.at(-1)?.get('page')).toBe('2');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('person1@example.com')).toBeInTheDocument();
  });

  it('shows one entry with what the table has no room for', async () => {
    api();
    await renderApp('/mail-suppressions');
    await userEvent.click(
      await screen.findByRole('button', { name: 'person1@example.com' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('General')).toBeInTheDocument();
    expect(
      within(dialog).getByText("Provider's last word"),
    ).toBeInTheDocument();
  });
});

describe('mail suppressions: add and remove', () => {
  it('adds an address with a note', async () => {
    const state = api();
    await renderApp('/mail-suppressions');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Add an address' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Email address'),
      'new@example.com',
    );
    await user.type(within(dialog).getByLabelText('Note'), 'Asked us to stop');
    await user.click(
      within(dialog).getByRole('button', { name: 'Add to the list' }),
    );
    await findToast('new@example.com is on the list.');
    expect(state.created).toEqual([
      { address: 'new@example.com', note: 'Asked us to stop' },
    ]);
    // The list is read again and shows it.
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses a bad address before sending', async () => {
    const state = api();
    await renderApp('/mail-suppressions');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Add an address' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Email address'), 'nope');
    await user.click(
      within(dialog).getByRole('button', { name: 'Add to the list' }),
    );
    expect(
      await within(dialog).findByText('Enter a valid email address.'),
    ).toBeInTheDocument();
    expect(state.created).toEqual([]);
  });

  it('says so when the address is listed already (409)', async () => {
    const state = api();
    await renderApp('/mail-suppressions');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Add an address' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Email address'),
      'person1@example.com',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Add to the list' }),
    );
    expect(
      await within(dialog).findByText('That address is listed already.'),
    ).toBeInTheDocument();
    expect(state.created).toHaveLength(1);
    // The dialog stays open to correct the address.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('removes an entry only after the confirmation', async () => {
    const state = api();
    await renderApp('/mail-suppressions');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove person1@example.com',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('Send mail to person1@example.com again?'),
    ).toBeInTheDocument();
    // Cancelling removes nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.removed).toEqual([]);

    await user.click(
      screen.getByRole('button', { name: 'Remove person1@example.com' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove from the list',
      }),
    );
    await findToast('person1@example.com is off the list.');
    expect(state.removed).toEqual([entry(1).id]);
    await waitFor(() =>
      expect(screen.queryByText('person1@example.com')).toBeNull(),
    );
  });

  it('warns about removing a complaint', async () => {
    api();
    await renderApp('/mail-suppressions');
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Remove person2@example.com',
      }),
    );
    expect(
      await screen.findByText(/reported our mail as spam/),
    ).toBeInTheDocument();
  });
});
