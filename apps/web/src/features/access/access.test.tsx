import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bob,
  everything,
  ids,
  invitation,
  signedInWith,
} from '@/features/access/test/fixtures';
import { nav, visibleGroups } from '@/nav';
import { principalsHandler, userPrincipal } from '@/test/principals';
import { renderApp } from '@/test/render-app';
import { allFeatures, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';

// Tests that watch which requests go out listen to msw's events.
afterEach(() => {
  server.events.removeAllListeners();
});

/** Records what each request sent. */
function capture(
  method: 'post' | 'patch' | 'delete',
  path: string,
  status = 204,
) {
  const calls: { url: string; body: unknown }[] = [];
  server.use(
    http[method](path, async ({ request }) => {
      const text = await request.text();
      calls.push({
        url: request.url,
        body: text ? JSON.parse(text) : undefined,
      });
      return status === 204
        ? new HttpResponse(null, { status })
        : HttpResponse.json(
            {
              id: ids.invitation,
              email: 'new@example.com',
              expiresAt: '2026-10-20T00:00:00Z',
            },
            { status },
          );
    }),
  );
  return calls;
}

describe('roles: the permission editor', () => {
  it('creates a role with the permissions ticked, as the catalog names them', async () => {
    signedInWith(everything);
    const created = capture('post', '/v1/access/roles', 201);
    const { router } = await renderApp('/access/roles/new');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Name'), 'Support');
    await user.click(screen.getByRole('checkbox', { name: /See notes/ }));
    // A rule appears: narrow it to "Created by me", and only the text.
    const rule = screen.getByRole('group', { name: 'Rule 1' });
    await user.click(
      within(rule).getByRole('checkbox', { name: /Created by me/ }),
    );
    await user.click(
      within(rule).getByRole('checkbox', { name: /All fields/ }),
    );
    await user.click(
      within(rule).getByRole('checkbox', { name: /The custom fields/ }),
    );
    await user.click(screen.getByRole('checkbox', { name: /Write notes/ }));
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).toEqual({
      name: 'Support',
      description: '',
      permissions: [
        {
          subject: 'Note',
          action: 'read',
          conditions: [{ key: 'mine' }],
          fields: ['body'],
        },
        { subject: 'Note', action: 'create', conditions: [] },
      ],
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/access/roles'),
    );
  });

  it('does not offer to grant what the user doesn’t hold', async () => {
    signedInWith({ 'Access.manageRoles': true, 'Note.read': true });
    await renderApp('/access/roles/new');
    expect(
      await screen.findByRole('checkbox', { name: /See notes/ }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('checkbox', { name: /Write notes/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a built-in role read-only', async () => {
    signedInWith(everything);
    await renderApp(`/access/roles/${ids.admin}`);
    expect(
      await screen.findByText(
        "This role is built in: it can't be changed or deleted.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull();
    expect(
      screen.getByText('Everything, including access control'),
    ).toBeVisible();
  });
});

describe('users: invitations', () => {
  it('invites an address with a role, and revokes a pending invitation', async () => {
    signedInWith(everything);
    const sent = capture('post', '/v1/access/users', 202);
    await renderApp('/access/users');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'new@example.com');
    await user.click(within(dialog).getByRole('checkbox', { name: /Editor/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /North/ }));
    await user.click(
      within(dialog).getByRole('button', { name: 'Send invitation' }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      email: 'new@example.com',
      roleIds: [ids.editor],
      roleExpiresAt: {},
      teamIds: [ids.north],
    });

    server.use(
      http.get('/v1/access/invitations', () =>
        HttpResponse.json({ items: [invitation] }),
      ),
    );
    const revoked = capture('delete', '/v1/access/invitations/:id');
    await user.click(screen.getByRole('tab', { name: 'Invitations' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await waitFor(() => expect(revoked).toHaveLength(1));
    expect(revoked[0]!.url).toMatch(`/v1/access/invitations/${ids.invitation}`);
  });
});

describe('users: resending an invitation', () => {
  it('resends through its own route (a recent sign-in asked first) and shows when its roles end', async () => {
    signedInWith(everything);
    server.use(
      http.get('/v1/access/invitations', () =>
        HttpResponse.json({ items: [invitation] }),
      ),
    );
    const invited = capture('post', '/v1/access/users', 202);
    // The first try is refused for an old sign-in; the dialog confirms it's
    // Ada, then the same request goes again.
    let tries = 0;
    const resent: string[] = [];
    server.use(
      http.post('/v1/access/invitations/:id/resend', ({ request }) => {
        tries += 1;
        if (tries === 1) {
          return HttpResponse.json(
            {
              status: 403,
              code: 'reauthentication_required',
              detail: 'Confirm it is you.',
              methods: ['password'],
            },
            {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
        resent.push(request.url);
        return HttpResponse.json(
          {
            id: ids.invitation,
            email: invitation.email,
            expiresAt: '2026-10-25T00:00:00.000Z',
          },
          { status: 202 },
        );
      }),
      http.post('/v1/auth/reauthenticate', () =>
        HttpResponse.json({ ok: true }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Invitations' }));
    const row = (await screen.findByText('new@example.com')).closest('tr')!;
    expect(row).toHaveTextContent('Editor');
    expect(row).toHaveTextContent(/Viewer · until/);
    expect(row).not.toHaveTextContent(/Editor · until/);

    await user.click(within(row).getByRole('button', { name: 'Resend' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Resend',
      }),
    );
    const reauth = await screen.findByRole('dialog', { name: /confirm/i });
    await user.type(within(reauth).getByLabelText(/Password/), 'secret');
    await user.click(within(reauth).getByRole('button', { name: /Confirm/ }));

    await findToast('A new link was sent to new@example.com.');
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatch(
      `/v1/access/invitations/${ids.invitation}/resend`,
    );
    // Never a second invitation in its place.
    expect(invited).toHaveLength(0);
  });
});

describe('users: roles of a member', () => {
  it('assigns a role; an ended grant isn’t sent back (it would come back for good)', async () => {
    signedInWith(everything);
    const changed = capture('patch', '/v1/access/users/:id');
    await renderApp('/access/users');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    const sheet = await screen.findByRole('dialog');
    // Viewer ended: not ticked, listed as ended.
    expect(
      within(sheet).getByRole('checkbox', { name: /Viewer/ }),
    ).not.toBeChecked();
    expect(within(sheet).getByText(/Ended grants.*Viewer/)).toBeVisible();
    await user.click(
      within(sheet).getByRole('checkbox', { name: /Administrator/ }),
    );
    await user.click(within(sheet).getByRole('button', { name: 'Save roles' }));

    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]!.url).toMatch(`/v1/access/users/${ids.bob}`);
    expect(changed[0]!.body).toEqual({
      roleIds: [ids.editor, ids.admin],
      roleExpiresAt: {},
    });
  });

  it('removes a member from the tenant (deactivates the membership)', async () => {
    signedInWith(everything);
    const changed = capture('patch', '/v1/access/users/:id');
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Remove from this workspace' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]!.body).toEqual({ active: false });
  });
});

describe('roles: one role', () => {
  it('reads the role on its own, not from the list', async () => {
    signedInWith(everything);
    let listed = 0;
    server.use(
      http.get('/v1/access/roles', () => {
        listed += 1;
        return HttpResponse.json({ items: [] });
      }),
    );
    await renderApp(`/access/roles/${ids.editor}`);
    expect(
      await screen.findByRole('heading', { name: 'Editor' }),
    ).toBeVisible();
    expect(await screen.findByLabelText('Name')).toHaveValue('Editor');
    expect(listed).toBe(0);
  });

  it('says so when there is no such role (404)', async () => {
    signedInWith(everything);
    await renderApp('/access/roles/00000000-0000-7000-8000-00000000ffff');
    expect(
      await screen.findByText("This role doesn't exist (any more)."),
    ).toBeVisible();
  });
});

describe('users: the members', () => {
  it('narrows the list to a team (`?teamId=`)', async () => {
    signedInWith(everything);
    const asked: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/access/users') {
        asked.push(url.searchParams.get('teamId'));
      }
    });
    await renderApp('/access/users');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('button', { name: /Carol Admin/ }),
    ).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Team' }));
    await user.click(await screen.findByRole('option', { name: /Sales/ }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Carol Admin/ })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: /Bob Builder/ })).toBeVisible();
    expect(asked).toContain(ids.sales);
  });

  it('opens a member as the API reads them, not as the row had them', async () => {
    signedInWith(everything);
    server.use(
      http.get('/v1/access/users/:id', () =>
        HttpResponse.json({
          ...bob,
          updatedAt: '2026-10-02T10:00:00.000Z',
          teamIds: [ids.north],
        }),
      ),
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    const sheet = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(sheet).getByRole('checkbox', { name: 'North' }),
      ).toBeChecked(),
    );
    expect(
      within(sheet).getByRole('checkbox', { name: 'Sales' }),
    ).not.toBeChecked();
  });
});

describe('teams: a team’s members', () => {
  it('lists the team’s members with `?teamId=`, and adds someone found by search', async () => {
    signedInWith(everything);
    const teamIds: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/access/users') {
        teamIds.push(url.searchParams.get('teamId'));
      }
    });
    server.use(
      principalsHandler([
        userPrincipal({
          id: ids.carol,
          email: 'carol@example.com',
          name: 'Carol Admin',
        }),
      ]),
    );
    const changed = capture('patch', '/v1/access/users/:id');
    await renderApp(`/access/teams/${ids.north}`);
    const user = userEvent.setup();
    expect(
      await screen.findByText('Nobody is in this team directly.'),
    ).toBeVisible();
    expect(teamIds).toEqual([ids.north]);

    await user.type(screen.getByLabelText('Add a member'), 'carol');
    await user.click(await screen.findByRole('option', { name: /Carol/ }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await findToast('carol@example.com added.');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.url).toMatch(`/v1/access/users/${ids.carol}`);
    // Her teams as the single read had them, plus this one.
    expect(changed[0]!.body).toEqual({ teamIds: [ids.north] });
  });
});

describe('gating', () => {
  it('shows each entry to whoever may read it', () => {
    const labels = (can: Record<string, boolean>) =>
      visibleGroups(nav, allFeatures, can)
        .flatMap((group) => group.items)
        .map((item) => item.to)
        .filter((to) => to.startsWith('/access'));
    expect(labels({ 'Access.manageUsers': true })).toEqual([
      '/access/users',
      '/access/teams',
    ]);
    expect(
      labels({ 'Access.manageRoles': true, 'Access.manageTeams': true }),
    ).toEqual(['/access/users', '/access/roles', '/access/teams']);
    // The API lets whoever impersonates list the users, to find whom.
    expect(labels({ 'Access.impersonate': true })).toEqual(['/access/users']);
    expect(labels({ 'Access.readAudit': true })).toEqual([]);
  });

  it('shows the members read-only to whoever only manages teams', async () => {
    signedInWith({ 'Access.manageTeams': true });
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText(/needs the permission to manage users/),
    ).toBeVisible();
    expect(
      within(sheet).getByRole('checkbox', { name: /Editor/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(sheet).queryByRole('button', { name: 'Save roles' }),
    ).toBeNull();
    expect(
      within(sheet).queryByRole('button', {
        name: 'Remove from this workspace',
      }),
    ).toBeNull();
    // No invitations (manageUsers only) and nobody to invite.
    expect(screen.queryByRole('tab', { name: 'Invitations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
  });

  it('lets whoever manages users read the teams, without changing the tree', async () => {
    signedInWith({ 'Access.manageUsers': true });
    await renderApp('/access/teams');
    expect(await screen.findByRole('link', { name: 'Sales' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it.each([
    ['/access/users', 'Access.manageRoles'],
    ['/access/roles', 'Access.manageUsers'],
    [`/access/roles/${ids.editor}`, 'Access.manageUsers'],
    ['/access/teams', 'Access.manageRoles'],
    ['/access/teams', 'Access.impersonate'],
  ])(
    'sends %s to the dashboard without its permission',
    async (path, other) => {
      signedInWith({ [other]: true });
      const { router } = await renderApp(path);
      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    },
  );
});

describe('impersonation', () => {
  async function openBob() {
    const app = await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    );
    return { ...app, user, sheet: await screen.findByRole('dialog') };
  }

  it('is hidden when the switch is off', async () => {
    signedInWith({ ...everything, 'Access.impersonate': true });
    const { sheet } = await openBob();
    await within(sheet).findByRole('button', { name: 'Save roles' });
    expect(
      within(sheet).queryByRole('button', { name: /Impersonate/ }),
    ).toBeNull();
  });

  it('is hidden without the permission', async () => {
    signedInWith(everything, { impersonation: true });
    const { sheet } = await openBob();
    await within(sheet).findByRole('button', { name: 'Save roles' });
    expect(
      within(sheet).queryByRole('button', { name: /Impersonate/ }),
    ).toBeNull();
  });

  it('is hidden for an administrator (the API refuses)', async () => {
    signedInWith(
      { ...everything, 'Access.impersonate': true },
      { impersonation: true },
    );
    await renderApp('/access/users');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Carol Admin/ }),
    );
    const sheet = await screen.findByRole('dialog');
    await within(sheet).findByRole('button', { name: 'Save roles' });
    expect(
      within(sheet).queryByRole('button', { name: /Impersonate/ }),
    ).toBeNull();
  });

  it('starts, resets the session and goes to the dashboard as the user, without a page load', async () => {
    signedInWith(
      { ...everything, 'Access.impersonate': true },
      { impersonation: true },
    );
    const started = capture('post', '/v1/access/users/:id/impersonate');
    const { user, sheet, queryClient, router } = await openBob();
    // The session is now Bob's, acted by Ada.
    const asBob = {
      ...signedInUser,
      user: {
        ...signedInUser.user,
        id: ids.bob,
        email: 'bob@example.com',
        name: 'Bob Builder',
        impersonator: { id: signedInUser.user.id, email: 'ada@example.com' },
      },
      can: { 'Note.read': true },
    };
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(asBob)));
    await user.click(
      within(sheet).getByRole('button', { name: /Impersonate/ }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Impersonate',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    // The mounted sidebar and banner changed in place: no page load.
    expect(
      await screen.findByRole('button', { name: /Bob Builder/ }),
    ).toBeVisible();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'ada@example.com',
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.url).toMatch(`/v1/access/users/${ids.bob}/impersonate`);
    // `me` is the user's.
    expect(queryClient.getQueryData(['auth', 'me'])).toEqual(asBob);
  });
});
