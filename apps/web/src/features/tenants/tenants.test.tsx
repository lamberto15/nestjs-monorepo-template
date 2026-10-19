import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { visibleGroups, nav } from '@/nav';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { slugify } from './queries';

const OPERATOR_ID = signedInUser.tenant!.id;
const row = (id: string, slug: string, extra: object = {}) => ({
  id,
  slug,
  name: slug,
  active: true,
  operator: false,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...extra,
});

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
    listed: 0,
    switched: [] as unknown[],
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
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

describe('gating', () => {
  it('hides the menu entry from a non-operator (403 operator_required)', async () => {
    const state = api({ operator: false });
    await renderApp('/');
    await screen.findByRole('link', { name: 'Dashboard' });
    await waitFor(() => expect(state.listed).toBe(1));
    expect(screen.queryByRole('link', { name: 'Tenants' })).toBeNull();
  });

  it('has no tenants page for a non-operator', async () => {
    api({ operator: false });
    await renderApp('/tenants');
    await screen.findByText(/not found|doesn.t exist/i);
    expect(screen.queryByRole('heading', { name: 'Tenants' })).toBeNull();
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
