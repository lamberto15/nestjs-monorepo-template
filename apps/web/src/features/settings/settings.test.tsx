import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import {
  clientPrincipal,
  principalsHandler,
  userPrincipal,
} from '@/test/principals';
import { peopleHandler, teamsHandler } from '@/test/people';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';
import { fromDraft, groupOf, overrideBody, toDraft } from './settings';

const admin = {
  ...signedInUser,
  can: { 'Access.manageSettings': true },
};

// A setting as GET /v1/settings describes it (docs/settings.md): its type,
// bounds, and what the caller may do (`canEdit`, `canSetMine`).
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
  type: 'json',
  schema: {},
  canEdit: true,
  canSetMine: false,
  ...extra,
});

const GRACE = userPrincipal({
  id: '0199a3f2-0000-7000-8000-000000000101',
  email: 'grace@example.com',
  name: 'Grace Hopper',
});
const BILLING = clientPrincipal({
  id: '0199a3f2-0000-7000-8000-000000000102',
  name: 'Billing sync',
});

const items = [
  setting({
    key: 'notes.richText',
    label: 'Rich text editor',
    flag: true,
    type: 'boolean',
    scopes: ['tenant', 'team', 'user'],
    value: false,
    default: false,
    canSetMine: true,
  }),
  setting({
    key: 'notes.publishDelay',
    label: 'Publication delay',
    type: 'string',
    maxLength: 10,
    value: '10s',
    default: '10s',
  }),
  setting({
    key: 'auth.passwordMinLength',
    label: 'Minimum password length',
    public: false,
    type: 'number',
    integer: true,
    min: 12,
    max: 64,
    value: 12,
    default: 12,
  }),
  setting({
    key: 'ui.config',
    label: 'Config blob',
    value: { a: 1 },
    default: { a: 1 },
  }),
  setting({
    key: 'ui.density',
    label: 'Density',
    type: 'enum',
    options: ['compact', 'comfortable'],
    scopes: ['tenant', 'user'],
    value: 'comfortable',
    default: 'comfortable',
    canSetMine: true,
  }),
  setting({
    key: 'ui.locked',
    label: 'Locked policy',
    type: 'boolean',
    value: true,
    default: true,
    canEdit: false,
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
    principalsHandler([GRACE, BILLING]),
  );
}

describe('value types', () => {
  const number = { type: 'number' as const };
  const json = { type: 'json' as const };

  it('turns drafts back into values, refusing what does not parse', () => {
    expect(fromDraft(number, '20')).toEqual({ ok: true, value: 20 });
    expect(fromDraft(number, '')).toEqual({
      ok: false,
      invalid: { reason: 'number' },
    });
    expect(fromDraft(json, '{"a":2}')).toEqual({ ok: true, value: { a: 2 } });
    expect(fromDraft(json, '{')).toEqual({
      ok: false,
      invalid: { reason: 'json' },
    });
    expect(fromDraft({ type: 'boolean' }, true)).toEqual({
      ok: true,
      value: true,
    });
    expect(toDraft(number, 5)).toBe('5');
    expect(groupOf('notes.publishDelay')).toBe('notes');
  });

  it('checks what the setting declares: bounds, whole numbers, options, length', () => {
    const length = { type: 'number' as const, integer: true, min: 12, max: 64 };
    expect(fromDraft(length, '11')).toEqual({
      ok: false,
      invalid: { reason: 'min', limit: 12 },
    });
    expect(fromDraft(length, '65')).toEqual({
      ok: false,
      invalid: { reason: 'max', limit: 64 },
    });
    expect(fromDraft(length, '12.5')).toEqual({
      ok: false,
      invalid: { reason: 'integer' },
    });
    expect(fromDraft(length, '20')).toEqual({ ok: true, value: 20 });
    // An enum's options keep their type: a number stays a number.
    const level = { type: 'enum' as const, options: ['low', 2] };
    expect(fromDraft(level, '2')).toEqual({ ok: true, value: 2 });
    expect(fromDraft(level, 'low')).toEqual({ ok: true, value: 'low' });
    expect(fromDraft(level, 'high')).toEqual({
      ok: false,
      invalid: { reason: 'enum' },
    });
    expect(toDraft(level, 2)).toBe('2');
    expect(fromDraft({ type: 'string', maxLength: 3 }, 'abcd')).toEqual({
      ok: false,
      invalid: { reason: 'maxLength', limit: 3 },
    });
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
  it('lists only the settings one may set for oneself, and saves, then resets', async () => {
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
    // An enum is a select of its options.
    expect(screen.getByRole('combobox', { name: 'Density' })).toBeVisible();
    await user.click(toggle);
    await user.click(
      within(
        screen
          .getByRole('switch', { name: 'Rich text editor' })
          .closest('form')!,
      ).getByRole('button', { name: 'Save' }),
    );
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

  it('groups by prefix, searches, and offers editing only where canEdit', async () => {
    api(admin);
    const user = userEvent.setup();
    await renderApp('/settings');
    expect(await screen.findByText('Sign-in policy')).toBeVisible();
    // Hidden from members: said by `public`, not by the `auth.` prefix.
    expect(screen.getByText('Managers only')).toBeVisible();
    // The API says who may set it: no edit button where canEdit is false.
    expect(
      screen.queryByRole('button', { name: 'Edit Locked policy' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Edit Minimum password length' }),
    ).toBeVisible();
    await user.type(screen.getByRole('searchbox'), 'delay');
    expect(screen.queryByText('Rich text editor')).not.toBeInTheDocument();
    expect(screen.getByText('Publication delay')).toBeVisible();
  });

  it('renders the input of each value type', async () => {
    api(admin);
    const flag = await open('Rich text editor');
    expect(within(flag.dialog).getByRole('switch')).toBeVisible();
  });

  it('renders a number with its declared bounds, and refuses one outside them', async () => {
    api(admin);
    let body: unknown;
    server.use(
      http.put('/v1/settings/:key', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const { user, dialog } = await open('Minimum password length');
    const input = within(dialog).getByLabelText('Value');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('min', '12');
    expect(input).toHaveAttribute('max', '64');
    expect(input).toHaveAttribute('step', '1');
    expect(within(dialog).getByText('From 12 to 64.')).toBeVisible();
    await user.clear(input);
    await user.type(input, '8');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter 12 or more.')).toBeVisible();
    // Hidden from members (`public: false`): the dialog says so.
    expect(
      within(dialog).getByText(
        'Only people who manage settings see this setting.',
      ),
    ).toBeVisible();
    expect(body).toBeUndefined();
  });

  it('renders an enum as a select of its options', async () => {
    api(admin);
    let body: unknown;
    server.use(
      http.put('/v1/settings/:key', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const { user, dialog } = await open('Density');
    await user.click(within(dialog).getByRole('combobox', { name: 'Value' }));
    await user.click(await screen.findByRole('option', { name: 'compact' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'tenant', value: 'compact' }),
    );
    await findToast('Saved.');
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

  it('saves a flag for an API client found by searching the principals', async () => {
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
    await user.click(await screen.findByRole('option', { name: 'User' }));
    const picker = await within(dialog).findByRole('combobox', {
      name: 'User',
    });
    await user.click(picker);
    // Dice UI takes the text a frame later: typed at once, not key by key.
    fireEvent.change(picker, { target: { value: 'bill' } });
    await user.click(
      await screen.findByRole('option', { name: /Billing sync/ }),
    );
    expect(
      screen.queryByRole('option', { name: /Grace Hopper/ }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        scope: 'user',
        scopeId: BILLING.key,
        value: true,
      }),
    );
  });

  it('refuses a user scope with nobody picked', async () => {
    api(admin);
    const { user, dialog } = await open('Rich text editor');
    await user.click(within(dialog).getByRole('combobox', { name: 'Scope' }));
    await user.click(await screen.findByRole('option', { name: 'User' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose a user or an API client.',
    );
  });

  it("names a stored value's user and team from the lookups", async () => {
    api(admin);
    const TEAM = '0199a3f2-0000-7000-8000-0000000000b1';
    server.use(
      peopleHandler([{ id: GRACE.id, name: 'Grace Hopper' }]),
      teamsHandler([{ id: TEAM, name: 'Night shift' }]),
      http.get('/v1/settings/:key/overrides', () =>
        HttpResponse.json({
          items: [
            {
              key: 'notes.richText',
              scope: 'user',
              scopeId: GRACE.key,
              value: true,
              rollout: null,
              updatedBy: 'x',
              updatedAt: '2026-10-17T00:00:00.000Z',
            },
            {
              key: 'notes.richText',
              scope: 'team',
              scopeId: TEAM,
              value: false,
              rollout: null,
              updatedBy: 'x',
              updatedAt: '2026-10-17T00:00:00.000Z',
            },
          ],
        }),
      ),
    );
    const { dialog } = await open('Rich text editor');
    expect(await within(dialog).findByText(/User: Grace Hopper/)).toBeVisible();
    expect(await within(dialog).findByText(/Team: Night shift/)).toBeVisible();
  });
});
