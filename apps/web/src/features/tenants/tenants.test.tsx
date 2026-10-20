import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { visibleGroups, nav } from '@/nav';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';
import { slugify } from './queries';

const OPERATOR_ID = signedInUser.tenant!.id;
const row = (id: string, slug: string, extra: object = {}) => ({
  id,
  slug,
  name: slug,
  active: true,
  operator: false,
  deletionRequestedAt: null as string | null,
  deletionScheduledFor: null as string | null,
  deletionStartedAt: null as string | null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...extra,
});

const etagOf = (tenant: { id: string; updatedAt: string }) =>
  `"${tenant.id}-${tenant.updatedAt}"`;

function api(
  options: {
    tenancy?: 'multi' | 'single';
    can?: boolean;
    operator?: boolean;
  } = {},
) {
  const state = {
    tenants: [
      row(OPERATOR_ID, 'acme', { operator: true, name: 'Acme' }),
      row('0199a3f2-0000-7000-8000-0000000000b1', 'globex', { name: 'Globex' }),
    ],
    created: undefined as unknown,
    patched: [] as {
      id: string;
      body: Record<string, unknown>;
      ifMatch: string | null;
    }[],
    /** The next PATCH is refused for an old sign-in (step-up), once. */
    reauthFirst: false,
    /** Another operator changed the tenant after it was read. */
    changedMeanwhile: false,
    listed: 0,
    switched: [] as unknown[],
    /** The next export / deletion POST is refused for an old sign-in, once. */
    reauthExport: false,
    reauthDeletion: false,
    exports: [] as {
      id: string;
      body: unknown;
      idempotencyKey: string | null;
    }[],
    deletions: [] as { id: string; body: unknown }[],
    cancels: 0,
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        tenant: { ...signedInUser.tenant!, operator: options.operator ?? true },
        can: { 'Access.manageTenants': options.can ?? true },
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
    http.get('/v1/auth/tenants', () =>
      HttpResponse.json({
        items: [
          { id: OPERATOR_ID, slug: 'acme', name: 'Acme', current: true },
          {
            id: '0199a3f2-0000-7000-8000-0000000000b1',
            slug: 'globex',
            name: 'Globex',
            current: false,
          },
        ],
      }),
    ),
    http.get('/v1/tenants', () => {
      state.listed += 1;
      return options.operator === false
        ? problem(403, 'operator_required')
        : HttpResponse.json({ items: state.tenants });
    }),
    http.post('/v1/tenants', async ({ request }) => {
      const body = (await request.json()) as {
        name: string;
        slug: string;
        administratorEmail: string;
      };
      state.created = body;
      if (body.slug === 'taken') {
        return problem(409, 'tenant_slug_taken');
      }
      const created = row('0199a3f2-0000-7000-8000-0000000000b2', body.slug, {
        name: body.name,
      });
      state.tenants = [...state.tenants, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.get('/v1/tenants/:id', ({ params }) => {
      const found = state.tenants.find((tenant) => tenant.id === params.id);
      return found
        ? HttpResponse.json(found, { headers: { etag: etagOf(found) } })
        : problem(404, 'not_found');
    }),
    http.patch('/v1/tenants/:id', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (state.reauthFirst) {
        state.reauthFirst = false;
        return problem(403, 'reauthentication_required', {
          methods: ['password'],
        });
      }
      const index = state.tenants.findIndex(
        (tenant) => tenant.id === params.id,
      );
      const found = state.tenants[index]!;
      const ifMatch = request.headers.get('if-match');
      state.patched.push({ id: found.id, body, ifMatch });
      if (state.changedMeanwhile) {
        // Another operator renamed it: its updatedAt, so its ETag, moved on.
        state.changedMeanwhile = false;
        state.tenants[index] = {
          ...found,
          name: 'Renamed elsewhere',
          updatedAt: '2026-10-11T08:00:00.000Z',
        };
        return problem(412, 'precondition_failed');
      }
      if (ifMatch && ifMatch !== etagOf(found)) {
        return problem(412, 'precondition_failed');
      }
      if (body.active === true && found.deletionScheduledFor) {
        return problem(409, 'tenant_deletion_pending');
      }
      if (body.slug === 'taken') {
        return problem(409, 'tenant_slug_taken', {
          errors: [{ path: 'slug', message: 'That slug is taken.' }],
        });
      }
      const saved = {
        ...found,
        ...body,
        updatedAt: new Date(Date.parse(found.updatedAt) + 1000).toISOString(),
      };
      state.tenants[index] = saved;
      return HttpResponse.json(saved, { headers: { etag: etagOf(saved) } });
    }),
    http.post('/v1/tenants/:id/export', async ({ params, request }) => {
      if (state.reauthExport) {
        state.reauthExport = false;
        return problem(403, 'reauthentication_required', {
          methods: ['password'],
        });
      }
      state.exports.push({
        id: params.id as string,
        body: await request.json(),
        idempotencyKey: request.headers.get('idempotency-key'),
      });
      return HttpResponse.json(
        { id: 'export-1', status: 'queued' },
        { status: 202 },
      );
    }),
    http.get('/v1/data/transfers/:id', ({ params }) =>
      HttpResponse.json({
        id: params.id,
        kind: 'export',
        name: 'tenant',
        format: 'json',
        status: 'completed',
        progress: { processed: 12 },
        result: { rows: 12, url: 'https://files.test/tenant.json' },
      }),
    ),
    http.post('/v1/tenants/:id/deletion', async ({ params, request }) => {
      if (state.reauthDeletion) {
        state.reauthDeletion = false;
        return problem(403, 'reauthentication_required', {
          methods: ['password'],
        });
      }
      const body = (await request.json()) as { slug: string };
      state.deletions.push({ id: params.id as string, body });
      const index = state.tenants.findIndex(
        (tenant) => tenant.id === params.id,
      );
      const found = state.tenants[index]!;
      if (body.slug !== found.slug) {
        return problem(400, 'validation_failed', {
          errors: [{ path: 'slug', message: 'Not this tenant’s slug.' }],
        });
      }
      const saved = {
        ...found,
        active: false,
        deletionRequestedAt: '2026-10-20T08:00:00.000Z',
        deletionScheduledFor: '2026-11-19T08:00:00.000Z',
        updatedAt: '2026-10-20T08:00:00.000Z',
      };
      state.tenants[index] = saved;
      return HttpResponse.json(saved);
    }),
    http.delete('/v1/tenants/:id/deletion', ({ params }) => {
      state.cancels += 1;
      const index = state.tenants.findIndex(
        (tenant) => tenant.id === params.id,
      );
      const found = state.tenants[index]!;
      if (found.deletionStartedAt) {
        return problem(409, 'tenant_deletion_started');
      }
      if (!found.deletionScheduledFor) {
        return problem(404, 'not_found');
      }
      const saved = {
        ...found,
        deletionRequestedAt: null,
        deletionScheduledFor: null,
        updatedAt: '2026-10-20T09:00:00.000Z',
      };
      state.tenants[index] = saved;
      return HttpResponse.json(saved);
    }),
    http.post('/v1/auth/tenant', async ({ request }) => {
      state.switched.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

describe('tenants page', () => {
  it('lists the tenants and the menu links to it', async () => {
    api();
    await renderApp('/tenants');
    expect(
      await screen.findByRole('heading', { name: 'Tenants' }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Globex')).toBeInTheDocument();
    expect(
      within(table).getByText('acme', { selector: 'td' }),
    ).toBeInTheDocument();
    expect(within(table).getByText('Operators')).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Tenants' }),
    ).toHaveAttribute('href', '/tenants');
  });

  it('switches to a tenant the user belongs to', async () => {
    const state = api();
    await renderApp('/tenants');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Switch to it' }),
    );
    await waitFor(() =>
      expect(state.switched).toEqual([
        { tenantId: '0199a3f2-0000-7000-8000-0000000000b1' },
      ]),
    );
  });

  it('creates a tenant: the body has the name, slug and administrator', async () => {
    const state = api();
    await renderApp('/tenants');
    await userEvent.click(
      await screen.findByRole('button', { name: 'New tenant' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Initech Ltd');
    // The slug follows the name until it is typed in.
    expect(within(dialog).getByLabelText('Slug')).toHaveValue('initech-ltd');
    await userEvent.type(
      within(dialog).getByLabelText("First administrator's email"),
      'boss@initech.example',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create tenant' }),
    );
    await waitFor(() =>
      expect(state.created).toEqual({
        name: 'Initech Ltd',
        slug: 'initech-ltd',
        administratorEmail: 'boss@initech.example',
      }),
    );
    expect(await screen.findByText('initech-ltd')).toBeInTheDocument();
  });

  it('refuses a bad slug and email before sending', async () => {
    const state = api();
    await renderApp('/tenants');
    await userEvent.click(
      await screen.findByRole('button', { name: 'New tenant' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Bad');
    const slug = within(dialog).getByLabelText('Slug');
    await userEvent.clear(slug);
    await userEvent.type(slug, 'Not--Valid');
    await userEvent.type(
      within(dialog).getByLabelText("First administrator's email"),
      'nope',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create tenant' }),
    );
    expect(
      await within(dialog).findByText(/Use lowercase letters and digits/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Enter a valid email address.'),
    ).toBeInTheDocument();
    expect(state.created).toBeUndefined();
  });

  it('shows the API refusal of a taken slug', async () => {
    api();
    await renderApp('/tenants');
    await userEvent.click(
      await screen.findByRole('button', { name: 'New tenant' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Taken');
    await userEvent.type(
      within(dialog).getByLabelText("First administrator's email"),
      'a@b.example',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create tenant' }),
    );
    expect(
      await within(dialog).findByText('tenant_slug_taken (test)'),
    ).toBeInTheDocument();
  });
});

const GLOBEX = '0199a3f2-0000-7000-8000-0000000000b1';

describe('tenant detail', () => {
  it('opens from the list and shows the tenant', async () => {
    api();
    await renderApp('/tenants');
    await userEvent.click(await screen.findByRole('link', { name: 'Globex' }));
    expect(
      await screen.findByRole('heading', { name: 'Globex' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Globex');
    expect(screen.getByLabelText('Slug')).toHaveValue('globex');
  });

  it('renames and changes the slug with the ETag as If-Match, sending only what changed', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Globex Corp');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await findToast('Tenant Globex Corp saved.');
    expect(state.patched).toEqual([
      {
        id: GLOBEX,
        body: { name: 'Globex Corp' },
        ifMatch: etagOf(row(GLOBEX, 'globex')),
      },
    ]);
    // The page shows the saved tenant (read again, new ETag).
    expect(
      await screen.findByRole('heading', { name: 'Globex Corp' }),
    ).toBeInTheDocument();
    const slug = screen.getByLabelText('Slug');
    await user.clear(slug);
    await user.type(slug, 'globex-corp');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.patched).toHaveLength(2));
    expect(state.patched[1]!.body).toEqual({ slug: 'globex-corp' });
    // The second change carries the ETag the first one's answer made.
    expect(state.patched[1]!.ifMatch).toBe(
      etagOf({ id: GLOBEX, updatedAt: '2026-10-10T08:00:01.000Z' }),
    );
  });

  it('refuses a bad slug before sending', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const slug = await screen.findByLabelText('Slug');
    await userEvent.clear(slug);
    await userEvent.type(slug, 'Not--Valid');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Use lowercase letters and digits/),
    ).toBeInTheDocument();
    expect(state.patched).toEqual([]);
  });

  it('shows a taken slug (409) on the slug field', async () => {
    api();
    await renderApp(`/tenants/${GLOBEX}`);
    const slug = await screen.findByLabelText('Slug');
    await userEvent.clear(slug);
    await userEvent.type(slug, 'taken');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That slug is taken.')).toBeInTheDocument();
  });

  it('tells a tenant changed meanwhile (412), keeps what was typed, and reloads on request', async () => {
    const state = api();
    state.changedMeanwhile = true;
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // The tenant moved on (new updatedAt) but the page did not read it
    // again: the alert stays and so does the input.
    expect(await screen.findByText('This tenant changed')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Mine');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(screen.queryByText('This tenant changed')).toBeNull(),
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Renamed elsewhere');
  });

  it('tells a tenant changed meanwhile when deactivating', async () => {
    const state = api();
    state.changedMeanwhile = true;
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Deactivate tenant',
      }),
    );
    expect(await screen.findByText('This tenant changed')).toBeInTheDocument();
  });

  it('deactivates after a confirmation, then reactivates after another', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    // Nothing is sent before the confirmation.
    const confirm = await screen.findByRole('alertdialog');
    expect(state.patched).toEqual([]);
    await user.click(
      within(confirm).getByRole('button', { name: 'Deactivate tenant' }),
    );
    await findToast('Tenant Globex deactivated.');
    expect(state.patched.map((call) => call.body)).toEqual([{ active: false }]);
    expect(state.patched[0]!.ifMatch).toBe(etagOf(row(GLOBEX, 'globex')));
    expect(await screen.findByText('Inactive')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Reactivate' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Reactivate tenant',
      }),
    );
    await findToast('Tenant Globex reactivated.');
    expect(state.patched.map((call) => call.body)).toEqual([
      { active: false },
      { active: true },
    ]);
  });

  it('changes nothing when the confirmation is cancelled', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(state.patched).toEqual([]);
  });

  it('offers no deactivation for the operator tenant', async () => {
    api();
    await renderApp(`/tenants/${OPERATOR_ID}`);
    await screen.findByRole('heading', { name: 'Acme' });
    expect(screen.getByText(/operator tenant/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });

  it('asks for a recent sign-in when the API wants one, then sends the change again', async () => {
    const state = api();
    state.reauthFirst = true;
    server.use(
      http.post('/v1/auth/reauthenticate', () =>
        HttpResponse.json({ ok: true }),
      ),
    );
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Deactivate tenant',
      }),
    );
    const reauth = await screen.findByRole('dialog', { name: /confirm/i });
    await user.type(within(reauth).getByLabelText(/Password/), 'secret');
    await user.click(within(reauth).getByRole('button', { name: /Confirm/ }));
    await findToast('Tenant Globex deactivated.');
    expect(state.patched.map((call) => call.body)).toEqual([{ active: false }]);
  });

  it('has no page for an id that is no UUID, and never asks', async () => {
    const state = api();
    await renderApp('/tenants/not-a-uuid');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(screen.queryByLabelText('Slug')).toBeNull();
    expect(state.patched).toEqual([]);
  });

  it('says so for a tenant that does not exist', async () => {
    api();
    await renderApp('/tenants/0199a3f2-0000-7000-8000-0000000000ff');
    expect(
      await screen.findByText('This tenant does not exist.'),
    ).toBeInTheDocument();
  });
});

const PENDING = {
  active: false,
  deletionRequestedAt: '2026-10-20T08:00:00.000Z',
  deletionScheduledFor: '2026-11-19T08:00:00.000Z',
  deletionStartedAt: null,
};

/** Globex with a deletion in the given state. */
function withDeletion(state: ReturnType<typeof api>, extra: object = PENDING) {
  state.tenants[1] = row(GLOBEX, 'globex', { name: 'Globex', ...extra });
}

const reauthenticate = () =>
  server.use(
    http.post('/v1/auth/reauthenticate', () => HttpResponse.json({ ok: true })),
  );

async function confirmReauth(user: ReturnType<typeof userEvent.setup>) {
  const reauth = await screen.findByRole('dialog', { name: /confirm/i });
  await user.type(within(reauth).getByLabelText(/Password/), 'secret');
  await user.click(within(reauth).getByRole('button', { name: /Confirm/ }));
}

describe('exporting a tenant', () => {
  it('starts the export with a key, follows the transfer and offers the link', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Export tenant data' }),
    );
    const download = await screen.findByRole('link', {
      name: 'Download (json)',
    });
    expect(download).toHaveAttribute('href', 'https://files.test/tenant.json');
    expect(screen.getByText('12 rows exported.')).toBeVisible();
    expect(state.exports).toHaveLength(1);
    expect(state.exports[0]).toMatchObject({
      id: GLOBEX,
      body: { format: 'json' },
    });
    expect(state.exports[0]!.idempotencyKey).toBeTruthy();
  });

  it('exports in the chosen format', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Format' }));
    await user.click(
      await screen.findByRole('option', { name: 'Excel (.xlsx)' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Export tenant data' }),
    );
    await screen.findByRole('link', { name: /Download/ });
    expect(state.exports.map((call) => call.body)).toEqual([
      { format: 'xlsx' },
    ]);
  });

  it('asks for a recent sign-in, then sends the export again', async () => {
    const state = api();
    state.reauthExport = true;
    reauthenticate();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Export tenant data' }),
    );
    await confirmReauth(user);
    await screen.findByRole('link', { name: 'Download (json)' });
    expect(state.exports).toHaveLength(1);
  });
});

describe('deleting a tenant', () => {
  const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole('button', { name: 'Delete tenant' }),
    );
    return screen.findByRole('dialog');
  };

  it('needs the exact slug typed before it can be sent', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    const submit = within(dialog).getByRole('button', {
      name: 'Delete the tenant',
    });
    expect(submit).toBeDisabled();
    const input = within(dialog).getByLabelText('Type globex to confirm');
    await user.type(input, 'globe');
    expect(submit).toBeDisabled();
    await user.type(input, 'xx');
    expect(submit).toBeDisabled();
    expect(state.deletions).toEqual([]);
  });

  it('schedules the deletion and shows when it is erased, with a cancel', async () => {
    const state = api();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText('Type globex to confirm'),
      'globex',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete the tenant' }),
    );
    await findToast(/Tenant Globex will be erased on/);
    expect(state.deletions).toEqual([{ id: GLOBEX, body: { slug: 'globex' } }]);
    const scheduled = await screen.findByText(/^Erased on /);
    expect(scheduled).toHaveTextContent('2026');
    expect(
      screen.getByRole('button', { name: 'Cancel deletion' }),
    ).toBeEnabled();
    expect(screen.getByText('Deletion pending')).toBeInTheDocument();
    // No second request to delete while one is pending.
    expect(screen.queryByRole('button', { name: 'Delete tenant' })).toBeNull();
  });

  it('shows the API refusal of a wrong slug on the field', async () => {
    api();
    server.use(
      http.post('/v1/tenants/:id/deletion', () =>
        problem(400, 'validation_failed', {
          errors: [{ path: 'slug', message: 'Not this tenant’s slug.' }],
        }),
      ),
    );
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText('Type globex to confirm'),
      'globex',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete the tenant' }),
    );
    expect(
      await within(dialog).findByText('Not this tenant’s slug.'),
    ).toBeInTheDocument();
  });

  it('asks for a recent sign-in, then sends the deletion again', async () => {
    const state = api();
    state.reauthDeletion = true;
    reauthenticate();
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText('Type globex to confirm'),
      'globex',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete the tenant' }),
    );
    await confirmReauth(user);
    await findToast(/Tenant Globex will be erased on/);
    expect(state.deletions).toHaveLength(1);
  });

  it('shows a pending deletion and cancels it', async () => {
    const state = api();
    withDeletion(state);
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    expect(await screen.findByText(/^Erased on /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    await findToast(/Deletion of Globex cancelled/);
    expect(state.cancels).toBe(1);
    // Back to the delete action; the tenant stays inactive.
    expect(
      await screen.findByRole('button', { name: 'Delete tenant' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Erased on /)).toBeNull();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('tells a deletion that already started (409) and offers no cancel', async () => {
    const state = api();
    withDeletion(state);
    // The erase starts after the page was read.
    server.use(
      http.delete('/v1/tenants/:id/deletion', () => {
        state.tenants[1] = row(GLOBEX, 'globex', {
          ...PENDING,
          deletionStartedAt: '2026-10-20T10:00:00.000Z',
        });
        return problem(409, 'tenant_deletion_started');
      }),
    );
    await renderApp(`/tenants/${GLOBEX}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Cancel deletion' }),
    );
    await findToast('The erase has started and can no longer be cancelled.');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Cancel deletion' }),
      ).toBeNull(),
    );
    expect(screen.getAllByText('Being erased').length).toBeGreaterThan(0);
  });

  it('blocks reactivating while a deletion is pending, and says why', async () => {
    const state = api();
    withDeletion(state);
    await renderApp(`/tenants/${GLOBEX}`);
    const reactivate = await screen.findByRole('button', {
      name: 'Reactivate',
    });
    expect(reactivate).toBeDisabled();
    expect(screen.getByText(/A deletion is pending/)).toBeInTheDocument();
    expect(state.patched).toEqual([]);
  });

  it('allows reactivating when no deletion is pending', async () => {
    const state = api();
    withDeletion(state, { active: false });
    await renderApp(`/tenants/${GLOBEX}`);
    expect(
      await screen.findByRole('button', { name: 'Reactivate' }),
    ).toBeEnabled();
    expect(screen.queryByText(/A deletion is pending/)).toBeNull();
  });

  it('offers no deletion for the operator tenant', async () => {
    api();
    await renderApp(`/tenants/${OPERATOR_ID}`);
    await screen.findByRole('heading', { name: 'Acme' });
    expect(screen.queryByRole('button', { name: 'Delete tenant' })).toBeNull();
    expect(screen.queryByText('Delete tenant')).toBeNull();
    // It can still be exported.
    expect(
      screen.getByRole('button', { name: 'Export tenant data' }),
    ).toBeInTheDocument();
  });

  it('marks the tenants with a pending deletion in the list', async () => {
    const state = api();
    withDeletion(state);
    await renderApp('/tenants');
    const table = await screen.findByRole('table');
    const globex = within(table).getByRole('row', { name: /Globex/ });
    expect(within(globex).getByText('Deletion pending')).toBeInTheDocument();
    const acme = within(table).getByRole('row', { name: /Acme/ });
    expect(within(acme).queryByText('Deletion pending')).toBeNull();
  });
});

describe('gating', () => {
  it('hides the menu entry from a tenant administrator who is no operator, and never asks', async () => {
    const state = api({ operator: false });
    await renderApp('/');
    await screen.findByRole('link', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Tenants' })).toBeNull();
    expect(state.listed).toBe(0);
  });

  it('has no tenants page for a non-operator, and never asks', async () => {
    const state = api({ operator: false });
    await renderApp('/tenants');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(screen.queryByRole('heading', { name: 'Tenants' })).toBeNull();
    expect(state.listed).toBe(0);
  });

  it('has no tenant detail page for a non-operator, and never asks', async () => {
    const state = api({ operator: false });
    await renderApp(`/tenants/${GLOBEX}`);
    await screen.findByText(/not found|doesn.t exist/i);
    expect(screen.queryByLabelText('Slug')).toBeNull();
    expect(state.patched).toEqual([]);
  });

  it('has no tenants page without the permission, and never asks', async () => {
    const state = api({ can: false });
    await renderApp('/tenants');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(state.listed).toBe(0);
  });

  it('has no tenants page when the deployment is single-tenant', async () => {
    const state = api({ tenancy: 'single' });
    await renderApp('/tenants');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(screen.queryByRole('link', { name: 'Tenants' })).toBeNull();
    expect(state.listed).toBe(0);
  });
});

describe('menu', () => {
  it('lists the entry in the operators group, for operators only', () => {
    const features = { ...allFeatures };
    const can = { 'Access.manageTenants': true };
    const ids = (operator: boolean) =>
      visibleGroups(nav, features, can, operator).map((g) => g.id);
    expect(ids(true)).toContain('operators');
    expect(ids(false)).not.toContain('operators');
  });
});

describe('slugify', () => {
  it('makes a valid slug of a name', () => {
    expect(slugify('Initech Ltd.')).toBe('initech-ltd');
    expect(slugify('  Über  Café -- 24 ')).toBe('uber-cafe-24');
    expect(slugify('x'.repeat(60))).toHaveLength(48);
    expect(slugify('日本')).toBe('');
  });
});
