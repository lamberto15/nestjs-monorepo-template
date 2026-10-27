import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { signedInWith } from '@/features/access/test/fixtures';
import { nav, visibleGroups } from '@/nav';
import { peopleHandler } from '@/test/people';
import { principalsHandler, userPrincipal } from '@/test/principals';
import { renderApp } from '@/test/render-app';
import { allFeatures, server, signedInUser } from '@/test/server';

const entry = (id: string, extra: object = {}) => ({
  id,
  at: '2026-10-17T16:33:23.083Z',
  actor: 'user:u1',
  actorLabel: 'noah@example.com',
  action: 'note.created',
  targetType: 'note',
  targetId: `target-${id}`,
  details: { title: 'Hello' },
  ip: '::1',
  ...extra,
});

/** GET /v1/lists/Audit, as the API describes the audit log's list. */
const description = {
  subject: 'Audit',
  fields: [
    {
      name: 'action',
      type: 'string',
      operators: ['eq', 'in', 'notIn', 'startsWith'],
      sortable: true,
      custom: false,
    },
    {
      name: 'actor',
      type: 'string',
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
      ref: 'principal',
    },
    {
      name: 'actorLabel',
      type: 'string',
      operators: ['eq', 'contains', 'startsWith'],
      sortable: false,
      custom: false,
    },
    {
      name: 'targetType',
      type: 'string',
      operators: ['eq', 'in', 'isNull'],
      sortable: false,
      custom: false,
    },
    {
      name: 'tenantId',
      type: 'uuid',
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
    },
    {
      name: 'at',
      type: 'datetime',
      operators: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
      custom: false,
    },
  ],
  select: [
    'id',
    'tenantId',
    'at',
    'actor',
    'actorLabel',
    'action',
    'targetType',
    'targetId',
    'details',
    'ip',
  ],
  search: false,
  recycleBin: false,
  defaultSort: '-at',
  limits: { defaultLimit: 50, maxLimit: 100 },
};

function auditApi(items: object[], nextPage: number | null = null) {
  const urls: URL[] = [];
  server.use(
    http.get('/v1/lists/Audit', () => HttpResponse.json(description)),
    principalsHandler([
      userPrincipal({ id: 'u1', email: 'noah@example.com', name: 'Noah' }),
    ]),
    http.get('/v1/access/audit', ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json({
        items,
        nextCursor: null,
        page: Number(url.searchParams.get('page') ?? 1),
        nextPage,
        total: items.length,
        pageCount: nextPage ? 2 : 1,
      });
    }),
  );
  return urls;
}

describe('the audit log page', () => {
  it('asks the list for the entries by the list state, the actor by name or address', async () => {
    signedInWith({ 'Access.readAudit': true });
    const urls = auditApi([entry('1')], 2);
    await renderApp(
      '/audit?actorLabel=iLike.noah&action=startsWith.note.&sort=at.asc',
    );

    expect(await screen.findByText('noah@example.com')).toBeInTheDocument();
    const last = urls.at(-1)!;
    expect(JSON.parse(last.searchParams.get('filter') ?? 'null')).toEqual({
      and: [
        { field: 'actorLabel', op: 'contains', value: 'noah' },
        { field: 'action', op: 'startsWith', value: 'note.' },
      ],
    });
    expect(last.searchParams.get('sort')).toBe('at');
    expect(last.searchParams.get('page')).toBe('1');
    // Only the columns shown are asked for; the details are among them.
    expect(last.searchParams.get('fields')).toBe(
      'at,actorLabel,action,targetType,targetId,ip,details',
    );
  });

  it('names the action for people and keeps its key as the title', async () => {
    auditApi([
      entry('1'),
      entry('2', { action: 'member.signed-in' }),
      entry('3', { action: 'widget.rotated-keys' }),
    ]);
    await renderApp('/audit');

    expect(await screen.findByTitle('note.created')).toHaveTextContent(
      'Note created',
    );
    expect(screen.getByTitle('member.signed-in')).toHaveTextContent(
      'Member signed in',
    );
    // No translation for it: the key spelled out.
    expect(screen.getByTitle('widget.rotated-keys')).toHaveTextContent(
      'Widget rotated keys',
    );
  });

  it('names an actor the entry stored no label for, in one request', async () => {
    signedInWith({ 'Access.readAudit': true });
    const NOOR = '0199a3f2-0000-7000-8000-000000000011';
    const GRACE = '0199a3f2-0000-7000-8000-000000000012';
    const asked: URLSearchParams[] = [];
    auditApi([
      entry('1', { actor: `user:${NOOR}`, actorLabel: null }),
      entry('2', { actor: `user:${GRACE}`, actorLabel: null }),
      entry('3', { actor: `user:${NOOR}`, actorLabel: null }),
      entry('4', { actor: 'system:cleanup', actorLabel: null }),
      entry('5'),
    ]);
    server.use(
      peopleHandler(
        [
          { id: NOOR, name: 'Noor Ahmed' },
          { id: GRACE, name: 'Grace Hopper' },
        ],
        [],
        asked,
      ),
    );
    await renderApp('/audit');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getAllByText('Noor Ahmed')).toHaveLength(2);
    // The stored label, or no person: as it is, and never asked for.
    expect(screen.getByText('system:cleanup')).toBeInTheDocument();
    expect(screen.getByText('noah@example.com')).toBeInTheDocument();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.get('key')?.split(',').sort()).toEqual(
      [`user:${NOOR}`, `user:${GRACE}`].sort(),
    );
  });

  it('pages on the server', async () => {
    signedInWith({ 'Access.readAudit': true });
    const urls = auditApi([entry('1')], 2);
    await renderApp('/audit');
    const user = userEvent.setup();
    expect(await screen.findByText('noah@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next page/i }));
    await vi.waitFor(() =>
      expect(urls.at(-1)!.searchParams.get('page')).toBe('2'),
    );
  });

  it('shows details as text, never as HTML', async () => {
    signedInWith({ 'Access.readAudit': true });
    auditApi([
      entry('1', {
        details: { name: '<img src=x onerror="alert(1)">', n: 1 },
      }),
    ]);
    await renderApp('/audit');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /open actions/i }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Show details' }),
    );
    const dialog = await screen.findByRole('dialog');
    const row = within(dialog)
      .getByText(/onerror/)
      .closest('pre')!;
    expect(row.querySelector('img')).toBeNull();
    // Shown as the JSON text it is: the markup is characters.
    expect(row).toHaveTextContent('<img src=x onerror=\\"alert(1)\\">');
    expect(within(row).queryByRole('img')).toBeNull();
    // Its address, under the list's own label for it.
    expect(within(dialog).getByText('IP address')).toBeVisible();
  });

  it('is gated: no nav entry and a redirect without the permission', async () => {
    const groups = (can: Record<string, boolean>) =>
      visibleGroups(nav, allFeatures, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(groups({})).not.toContain('/audit');
    expect(groups({ 'Access.readAudit': true })).toContain('/audit');

    signedInWith({});
    const { router } = await renderApp('/audit');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

describe('the audit log across the tenant tree', () => {
  const SUB = '0199a3f2-0000-7000-8000-0000000000bb';
  const subTenants = () =>
    http.get('/v1/access/consolidated/tenants', () =>
      HttpResponse.json({
        items: [
          {
            id: SUB,
            slug: 'alpha',
            name: 'Alpha Ltd',
            parentId: null,
            depth: 1,
          },
        ],
      }),
    );

  it('has no switch without Access.readConsolidated', async () => {
    signedInWith({ 'Access.readAudit': true });
    auditApi([entry('1')]);
    await renderApp('/audit');
    expect(await screen.findByText('noah@example.com')).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Include sub-tenants' }),
    ).toBeNull();
  });

  it('reads the consolidated route with a tenant column and names the sub-tenants', async () => {
    signedInWith({ 'Access.readAudit': true, 'Access.readConsolidated': true });
    auditApi([entry('0')]);
    const urls: URL[] = [];
    server.use(
      subTenants(),
      http.get('/v1/access/consolidated/audit', ({ request }) => {
        const url = new URL(request.url);
        urls.push(url);
        return HttpResponse.json({
          items: [entry('1', { tenantId: SUB })],
          nextCursor: null,
          page: 1,
          nextPage: null,
          total: 1,
          pageCount: 1,
        });
      }),
    );
    await renderApp('/audit');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('switch', { name: 'Include sub-tenants' }),
    );

    expect(await screen.findByText('Alpha Ltd')).toBeInTheDocument();
    expect(await screen.findByText(/Including: Alpha Ltd/)).toBeInTheDocument();
    // tenantId is a declared field, so the column asks for it by name.
    expect(urls.at(-1)!.searchParams.get('fields')?.split(',')).toContain(
      'tenantId',
    );
  });

  it('offers no switch while impersonating', async () => {
    signedInWith({ 'Access.readAudit': true, 'Access.readConsolidated': true });
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          can: { 'Access.readAudit': true, 'Access.readConsolidated': true },
          user: {
            ...signedInUser.user,
            impersonator: { id: 'a1', name: 'Admin' },
          },
        }),
      ),
    );
    auditApi([entry('1')]);
    await renderApp('/audit');
    expect(await screen.findByText('noah@example.com')).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Include sub-tenants' }),
    ).toBeNull();
  });
});
