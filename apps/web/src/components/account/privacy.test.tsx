import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmsEmail } from '@/components/account/deletion-section';
import { settleReauthentication } from '@/lib/reauth';
import { meQuery } from '@/lib/session';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

const deletion = {
  requestedAt: '2026-10-20T09:00:00.000Z',
  scheduledFor: '2026-11-03T09:00:00.000Z',
};

/** The API's /v1/account as the page sees it; a write changes what a read brings. */
function useAccountApi(
  options: {
    impersonating?: boolean;
    consents?: { kind: string; version: string; acceptedAt: string }[];
  } = {},
) {
  const state = {
    signedIn: true,
    accountReads: 0,
    deletion: null as typeof deletion | null,
    consents: options.consents ?? [],
    consentBodies: [] as unknown[],
    exportBodies: [] as unknown[],
    deletionBodies: [] as unknown[],
    deletionCalls: 0,
    stepUpFirst: false,
    endSessionOnDeletion: false,
    cancelled: 0,
    statusReads: 0,
  };
  const user = options.impersonating
    ? {
        ...signedInUser.user,
        impersonator: { id: 'admin', email: 'admin@example.com' },
      }
    : signedInUser.user;
  server.use(
    // No socket in these tests: the bell polls its count instead.
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/auth/me', () =>
      state.signedIn
        ? HttpResponse.json({ ...signedInUser, user })
        : problem(401, 'unauthorized'),
    ),
    http.get('/v1/account', () => {
      state.accountReads++;
      return options.impersonating
        ? problem(403, 'forbidden')
        : HttpResponse.json({
            deletion: state.deletion,
            consents: state.consents,
          });
    }),
    http.post('/v1/account/consents', async ({ request }) => {
      const body = (await request.json()) as { kind: string; version: string };
      state.consentBodies.push(body);
      const saved = { ...body, acceptedAt: '2026-10-20T10:00:00.000Z' };
      state.consents = [
        saved,
        ...state.consents.filter((c) => c.kind !== body.kind),
      ];
      return HttpResponse.json(saved, { status: 201 });
    }),
    http.post('/v1/account/export', async ({ request }) => {
      state.exportBodies.push(await request.json());
      return HttpResponse.json(
        { id: 'export-1', status: 'queued' },
        { status: 202 },
      );
    }),
    http.get('/v1/data/transfers/:id', ({ params }) => {
      state.statusReads++;
      const done = state.statusReads > 1;
      return HttpResponse.json({
        id: params.id,
        kind: 'export',
        name: 'account',
        format: 'json',
        status: done ? 'completed' : 'queued',
        progress: {},
        ...(done && {
          result: { rows: 42, url: 'https://files.example.com/export-1.json' },
        }),
      });
    }),
    http.post('/v1/account/deletion', async ({ request }) => {
      state.deletionCalls++;
      const body = await request.json();
      if (state.stepUpFirst && state.deletionCalls === 1) {
        return problem(403, 'reauthentication_required', {
          methods: ['password'],
        });
      }
      state.deletionBodies.push(body);
      state.deletion = deletion;
      if (state.endSessionOnDeletion) {
        state.signedIn = false;
      }
      return HttpResponse.json(deletion);
    }),
    http.delete('/v1/account/deletion', () => {
      state.cancelled++;
      state.deletion = null;
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/v1/auth/reauthenticate', () => HttpResponse.json({ ok: true })),
  );
  return state;
}

async function openDeletion() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Delete my account…' }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Delete your account?',
  });
  return { user, dialog };
}

describe('the privacy page', () => {
  beforeEach(() => localStorage.clear());
  // The re-authenticate dialog's request is module state: never left open.
  afterEach(() => act(() => settleReauthentication(false)));

  it('starts an export, shows its progress, then its download', async () => {
    const api = useAccountApi();
    await renderApp('/account/privacy');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Export my data' }),
    );
    expect(await screen.findByText('Waiting for a worker…')).toBeVisible();
    expect(api.exportBodies).toEqual([{ format: 'json' }]);
    // Polled until the worker is done (transfer/api.ts, every second).
    const link = await screen.findByRole('link', { name: 'Download (json)' });
    expect(link).toHaveAttribute(
      'href',
      'https://files.example.com/export-1.json',
    );
    expect(screen.getByText('42 rows exported.')).toBeVisible();
    // Remembered in this browser apart from /transfers' list.
    expect(
      JSON.parse(localStorage.getItem('account-exports')!)[
        signedInUser.user.id
      ][0].id,
    ).toBe('export-1');
    expect(localStorage.getItem('transfers')).toBeNull();
  });

  it('lists the consents, gives one, and locks what is given', async () => {
    const api = useAccountApi({
      consents: [
        {
          kind: 'terms',
          version: '2026-01',
          acceptedAt: '2026-01-05T08:00:00.000Z',
        },
        {
          kind: 'privacy',
          version: '2025-06',
          acceptedAt: '2025-06-01T08:00:00.000Z',
        },
      ],
    });
    await renderApp('/account/privacy');
    const user = userEvent.setup();

    const terms = await screen.findByRole('switch', {
      name: 'Terms of service',
    });
    expect(terms).toHaveAttribute('aria-checked', 'true');
    expect(terms).toHaveAttribute('data-disabled');
    expect(
      screen.getByText("Required to use the app: it can't be withdrawn here."),
    ).toBeVisible();

    // An older version: not the current one, so it can be given again.
    const privacy = screen.getByRole('switch', { name: 'Privacy policy' });
    expect(privacy).toHaveAttribute('aria-checked', 'false');
    expect(privacy).not.toHaveAttribute('data-disabled');
    expect(
      screen.getByText(
        /You accepted version 2025-06 on .*; version 2026-01 is current\./,
      ),
    ).toBeVisible();

    const marketing = screen.getByRole('switch', {
      name: 'News and offers by email',
    });
    expect(marketing).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Not given (version 2026-01).')).toBeVisible();
    await user.click(marketing);
    await waitFor(() =>
      expect(marketing).toHaveAttribute('aria-checked', 'true'),
    );
    expect(api.consentBodies).toEqual([
      { kind: 'marketing', version: '2026-01' },
    ]);
    // No route withdraws a consent: once given, the switch is locked.
    expect(marketing).toHaveAttribute('data-disabled');
    expect(
      screen.getByText("Withdrawing isn't available here yet."),
    ).toBeVisible();
    await user.click(marketing);
    expect(api.consentBodies).toHaveLength(1);
  });

  it("won't ask for the deletion until the address is typed", async () => {
    const api = useAccountApi();
    await renderApp('/account/privacy');
    const { user, dialog } = await openDeletion();
    const submit = within(dialog).getByRole('button', {
      name: 'Delete my account',
    });
    expect(submit).toBeDisabled();
    const email = within(dialog).getByLabelText('Type ada@example.com');
    await user.type(email, 'someone@example.com');
    expect(submit).toBeDisabled();
    await user.keyboard('{Enter}');
    await user.clear(email);
    await user.type(email, 'Ada@Example.com');
    expect(submit).toBeEnabled();
    expect(api.deletionCalls).toBe(0);
  });

  it('passes the step-up through, then shows the pending deletion and the mailed link', async () => {
    const api = useAccountApi();
    api.stepUpFirst = true;
    const { queryClient, router } = await renderApp('/account/privacy');
    const { user, dialog } = await openDeletion();
    await user.type(
      within(dialog).getByLabelText('Type ada@example.com'),
      'ada@example.com',
    );
    await user.type(within(dialog).getByLabelText('Password'), 'secret');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete my account' }),
    );

    const reauth = await screen.findByRole('dialog', { name: /confirm/i });
    await user.type(within(reauth).getByLabelText(/Password/), 'secret');
    await user.click(within(reauth).getByRole('button', { name: /Confirm/ }));

    // Sent again after the step-up, with the same body.
    await waitFor(() =>
      expect(api.deletionBodies).toEqual([{ password: 'secret' }]),
    );
    expect(api.deletionCalls).toBe(2);
    expect(
      await screen.findByText(/Your account will be deleted on .*\.$/, {
        selector: '[data-slot="alert-title"]',
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/We emailed ada@example.com a link to cancel it/),
    ).toBeVisible();
    // The API keeps the session until the deletion is carried out.
    expect(router.state.location.pathname).toBe('/account/privacy');
    expect(queryClient.getQueryData(meQuery.queryKey)).not.toBeNull();
    // Nor does the password stay in the mutation cache.
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((m) => m.state.variables),
        ),
      ).not.toContain('secret'),
    );

    // Keeping the account cancels it.
    await user.click(screen.getByRole('button', { name: 'Keep my account' }));
    expect(
      await screen.findByRole('button', { name: 'Delete my account…' }),
    ).toBeVisible();
    expect(api.cancelled).toBe(1);
  });

  it('shows the password refused on its own, nothing scheduled', async () => {
    const api = useAccountApi();
    server.use(
      http.post('/v1/account/deletion', () =>
        problem(400, 'validation_failed', {
          errors: [{ path: 'password', message: 'Required.' }],
        }),
      ),
    );
    await renderApp('/account/privacy');
    const { user, dialog } = await openDeletion();
    await user.type(
      within(dialog).getByLabelText('Type ada@example.com'),
      'ada@example.com',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete my account' }),
    );
    expect(await within(dialog).findByText('Required.')).toBeVisible();
    expect(api.deletion).toBeNull();
  });

  it('clears the session when the API ended it', async () => {
    const api = useAccountApi();
    api.endSessionOnDeletion = true;
    const { queryClient, router } = await renderApp('/account/privacy');
    const { user, dialog } = await openDeletion();
    await user.type(
      within(dialog).getByLabelText('Type ada@example.com'),
      'ada@example.com',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete my account' }),
    );
    // No password typed: the body names none (a passwordless account).
    await waitFor(() => expect(api.deletionBodies).toEqual([{}]));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sign-in'),
    );
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
    expect(queryClient.getQueryData(['account'])).toBeUndefined();
  });

  it('offers nothing while impersonating', async () => {
    const api = useAccountApi({ impersonating: true });
    await renderApp('/account/privacy');
    expect(
      await screen.findByText(
        'While acting as someone, their data, consents and account deletion stay theirs.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Export my data' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Delete my account…' }),
    ).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(api.accountReads).toBe(0);
  });
});

describe('confirmsEmail', () => {
  it('compares addresses case aside, never a part of one', () => {
    expect(confirmsEmail(' Ada@Example.com ', 'ada@example.com')).toBe(true);
    expect(confirmsEmail('ada@example.co', 'ada@example.com')).toBe(false);
    expect(confirmsEmail('', 'ada@example.com')).toBe(false);
  });
});

describe("the deletion mail's cancel link", () => {
  it('cancels only when the button is pressed, with the token', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/v1/account/deletion/cancel', async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await renderApp('/cancel-deletion?token=abc.def');
    const button = await screen.findByRole('button', {
      name: 'Cancel the deletion',
    });
    // A mail scanner that opens the link cancels nothing.
    expect(bodies).toEqual([]);
    await userEvent.setup().click(button);
    expect(
      await screen.findByText('The deletion is cancelled: your account stays.'),
    ).toBeVisible();
    expect(bodies).toEqual([{ token: 'abc.def' }]);
  });
});
