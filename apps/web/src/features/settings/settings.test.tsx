import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';
import { fromDraft, groupOf, kindOf, overrideBody, toDraft } from './settings';

const admin = {
  ...signedInUser,
  can: { 'Access.manageSettings': true },
};

const setting = (extra: object) => ({
  key: 'x.y',
  label: 'Label',
  description: null,
  flag: false,
  scopes: ['tenant'],
  public: true,
  value: null,
  source: 'default',
  default: null,
  ...extra,
});

const items = [
  setting({
    key: 'notes.richText',
    label: 'Rich text editor',
    flag: true,
    scopes: ['tenant', 'team', 'user'],
    value: false,
    default: false,
  }),
  setting({
    key: 'notes.publishDelay',
    label: 'Publication delay',
    value: '10s',
    default: '10s',
  }),
  setting({
    key: 'auth.passwordMinLength',
    label: 'Minimum password length',
    public: false,
    value: 12,
    default: 12,
  }),
  setting({
    key: 'ui.config',
    label: 'Config blob',
    value: { a: 1 },
    default: { a: 1 },
  }),
];

function api(me: object, list: object[] = items) {
  server.use(
    http.get('/v1/auth/me', () => HttpResponse.json(me)),
    http.get('/v1/settings', () => HttpResponse.json({ items: list })),
    http.get('/v1/settings/:key/overrides', () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get('/v1/access/teams', () =>
      HttpResponse.json({
        items: [{ id: 'team-1', name: 'Editors', parentId: null, depth: 0 }],
      }),
    ),
    http.get('/v1/access/users', () =>
      HttpResponse.json({
        items: [{ id: 'u1', name: 'Grace', email: 'grace@example.com' }],
      }),
    ),
  );
}

describe('value types', () => {
  it('picks the input from the default', () => {
    expect(kindOf({ flag: true, default: false })).toBe('boolean');
    expect(kindOf({ flag: false, default: 12 })).toBe('number');
    expect(kindOf({ flag: false, default: '10s' })).toBe('string');
    expect(kindOf({ flag: false, default: null })).toBe('json');
    expect(kindOf({ flag: false, default: { a: 1 } })).toBe('json');
  });

  it('turns drafts back into values, refusing what does not parse', () => {
    expect(fromDraft('number', '20')).toEqual({ ok: true, value: 20 });
    expect(fromDraft('number', '')).toEqual({ ok: false });
    expect(fromDraft('json', '{"a":2}')).toEqual({ ok: true, value: { a: 2 } });
    expect(fromDraft('json', '{')).toEqual({ ok: false });
    expect(fromDraft('boolean', true)).toEqual({ ok: true, value: true });
    expect(toDraft('number', 5)).toBe('5');
    expect(groupOf('notes.publishDelay')).toBe('notes');
  });

  it('builds the body per scope', () => {
    expect(
      overrideBody({ scope: 'tenant', scopeId: 'ignored', value: 1 }),
    ).toEqual({
      scope: 'tenant',
      value: 1,
    });
    expect(overrideBody({ scope: 'team', scopeId: 't', value: true })).toEqual({
      scope: 'team',
      scopeId: 't',
      value: true,
    });
    expect(overrideBody({ scope: 'tenant', scopeId: '', rollout: 20 })).toEqual(
      {
        scope: 'tenant',
        rollout: 20,
      },
    );
  });
});

describe('gating', () => {
  it('has no menu entry without the permission, one with it', () => {
    const names = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(names({})).not.toContain('/settings');
    expect(names({ 'Access.manageSettings': true })).toContain('/settings');
  });

  it('sends a user without the permission away from the route', async () => {
    api(signedInUser);
    const { router } = await renderApp('/settings');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

describe('my preferences', () => {
  it('lists only the settings with the user scope and saves, then resets', async () => {
    api(signedInUser);
    let saved: unknown;
    let deleted = false;
    server.use(
      http.put('/v1/settings/:key/mine', async ({ request, params }) => {
        saved = { key: params.key, body: await request.json() };
        return HttpResponse.json({
          ...items[0],
          value: true,
          source: 'user',
        });
      }),
      http.delete('/v1/settings/:key/mine', () => {
        deleted = true;
        return HttpResponse.json(items[0]);
      }),
    );
    const user = userEvent.setup();
    await renderApp('/account/preferences');
    const toggle = await screen.findByRole('switch', {
      name: 'Rich text editor',
    });
    expect(screen.queryByText('Publication delay')).not.toBeInTheDocument();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual({ key: 'notes.richText', body: { value: true } }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Reset to default' }),
    );
    await waitFor(() => expect(deleted).toBe(true));
  });
});

describe('admin settings', () => {
  async function open(name: string) {
    const user = userEvent.setup();
    await renderApp('/settings');
    await user.click(
      await screen.findByRole('button', { name: `Edit ${name}` }),
    );
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('groups by prefix, searches, and notes the auth policies', async () => {
    api(admin);
    const user = userEvent.setup();
    await renderApp('/settings');
    expect(await screen.findByText('Sign-in policy')).toBeVisible();
    expect(screen.getByText(/only managers can see and change/)).toBeVisible();
    await user.type(screen.getByRole('searchbox'), 'delay');
    expect(screen.queryByText('Rich text editor')).not.toBeInTheDocument();
    expect(screen.getByText('Publication delay')).toBeVisible();
  });

  it('renders the input of each value type', async () => {
    api(admin);
    const flag = await open('Rich text editor');
    expect(within(flag.dialog).getByRole('switch')).toBeVisible();
  });

  it('renders a number, a string and JSON', async () => {
    api(admin);
    const number = await open('Minimum password length');
    expect(within(number.dialog).getByLabelText('Value')).toHaveAttribute(
      'type',
      'number',
    );
  });

  it('renders JSON as a textarea', async () => {
    api(admin);
    const json = await open('Config blob');
    expect(within(json.dialog).getByLabelText('Value').tagName).toBe(
      'TEXTAREA',
    );
  });

  it('saves a string at the tenant scope', async () => {
    api(admin);
    let body: unknown;
    server.use(
      http.put('/v1/settings/:key', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const { user, dialog } = await open('Publication delay');
    const input = within(dialog).getByLabelText('Value');
    await user.clear(input);
    await user.type(input, '5m');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ scope: 'tenant', value: '5m' }));
  });

  it('saves a flag for a team', async () => {
    api(admin);
    let body: unknown;
    server.use(
      http.put('/v1/settings/:key', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const { user, dialog } = await open('Rich text editor');
    await user.click(within(dialog).getByRole('combobox', { name: 'Scope' }));
    await user.click(await screen.findByRole('option', { name: 'Team' }));
    await user.click(
      await within(dialog).findByRole('combobox', { name: 'Team' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Editors' }));
    await user.click(within(dialog).getByRole('switch'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'team', scopeId: 'team-1', value: true }),
    );
  });

  it('saves a rollout with no value', async () => {
    api(admin);
    let body: unknown;
    server.use(
      http.put('/v1/settings/:key', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const { user, dialog } = await open('Rich text editor');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Applies as' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'A gradual rollout' }),
    );
    const percent = within(dialog).getByRole('spinbutton');
    await user.clear(percent);
    await user.type(percent, '20');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ scope: 'tenant', rollout: 20 }));
  });

  it('clears an override with its scope in the query', async () => {
    api(admin);
    let url = '';
    server.use(
      http.get('/v1/settings/:key/overrides', () =>
        HttpResponse.json({
          items: [
            {
              key: 'notes.richText',
              scope: 'team',
              scopeId: 'team-1',
              value: true,
              rollout: null,
              updatedBy: 'x',
              updatedAt: '2026-10-17T00:00:00.000Z',
            },
          ],
        }),
      ),
      http.delete('/v1/settings/:key', ({ request }) => {
        url = new URL(request.url).search;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user, dialog } = await open('Rich text editor');
    await user.click(
      await within(dialog).findByRole('button', { name: 'Clear' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Clear',
      }),
    );
    await waitFor(() => expect(url).toBe('?scope=team&scopeId=team-1'));
  });
});
