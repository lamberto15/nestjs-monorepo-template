import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

const none = { items: [], nextCursor: null };

/** Answers what the checklist reads: the tenant's real state. */
function useTenant(state: {
  members?: number;
  roleKeys?: (string | null)[];
  primaryColor?: string | null;
}) {
  server.use(
    http.get('/v1/access/users', () =>
      HttpResponse.json({
        items: Array.from({ length: state.members ?? 1 }, (_, i) => ({
          id: `u${i}`,
        })),
        nextCursor: null,
      }),
    ),
    http.get('/v1/access/invitations', () => HttpResponse.json(none)),
    http.get('/v1/access/roles', () =>
      HttpResponse.json({
        items: (state.roleKeys ?? ['administrator']).map((key, i) => ({
          id: `r${i}`,
          key,
        })),
      }),
    ),
    http.get('/v1/branding', () =>
      HttpResponse.json({
        primaryColor: state.primaryColor ?? null,
        mailFromName: null,
        logoUrl: null,
        locked: false,
        canEdit: true,
      }),
    ),
  );
}

const card = () =>
  screen
    .getByRole('heading', { name: 'Set up your organization' })
    .closest('[data-slot="card"]') as HTMLElement;

describe('the organization setup checklist', () => {
  it('ticks the steps the tenant has done and shows only the permitted ones', async () => {
    useSignedIn([
      'Access.manageUsers',
      'Access.manageRoles',
      'Access.manageSettings',
    ]);
    useTenant({ members: 3, roleKeys: ['administrator'], primaryColor: null });
    await renderApp('/');

    expect(await screen.findByText('1 of 3 steps done')).toBeVisible();
    const list = within(card());
    expect(list.getByRole('link', { name: 'Invite your team' })).toBeVisible();
    expect(
      list.getByRole('link', { name: 'Create a custom role' }),
    ).toBeVisible();
    expect(list.getByRole('link', { name: 'Add your branding' })).toBeVisible();
    // No permission, no step.
    expect(list.queryByRole('link', { name: 'Create tags' })).toBeNull();
    expect(list.getAllByLabelText('Done')).toHaveLength(1);
  });

  it('reads the tenant, not the administrator: a second one sees the progress of the first', async () => {
    useSignedIn(['Access.manageRoles', 'Access.manageSettings']);
    useTenant({ roleKeys: ['administrator', null], primaryColor: '#336699' });
    await renderApp('/');

    expect(await screen.findByText('2 of 2 steps done')).toBeVisible();
  });

  it('shows no card to someone with no setup permission', async () => {
    useSignedIn([]);
    await renderApp('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(
      screen.queryByRole('heading', { name: 'Set up your organization' }),
    ).toBeNull();
  });
});
