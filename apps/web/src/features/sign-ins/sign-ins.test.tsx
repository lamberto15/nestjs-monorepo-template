import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { signedInWith } from '@/features/access/test/fixtures';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { allFeatures, server } from '@/test/server';

const entry = (id: string, extra: object = {}) => ({
  id,
  at: '2026-10-17T16:33:23.083Z',
  user: 'user:u1',
  userLabel: 'noah@example.com',
  userName: 'Noah',
  result: 'success',
  method: 'password',
  via: null,
  userAgent: 'Chrome on macOS',
  ip: '::1',
  ...extra,
});

/** GET /v1/lists/SignIn, as the API describes the sign-in history's list. */
const description = {
  subject: 'SignIn',
  fields: [
    {
      name: 'result',
      type: 'string',
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
    },
    {
      name: 'method',
      type: 'string',
      operators: ['eq', 'in', 'startsWith'],
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
    'at',
    'user',
    'userLabel',
    'userName',
    'result',
    'method',
    'via',
    'userAgent',
    'ip',
  ],
  search: false,
  recycleBin: false,
  defaultSort: '-at',
  limits: { defaultLimit: 50, maxLimit: 100 },
};

function signInsApi(items: object[]) {
  const urls: URL[] = [];
  server.use(
    http.get('/v1/lists/SignIn', () => HttpResponse.json(description)),
    http.get('/v1/access/sign-ins', ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json({
        items,
        nextCursor: null,
        page: 1,
        nextPage: null,
        total: items.length,
        pageCount: 1,
      });
    }),
  );
  return urls;
}

describe('the sign-in history page', () => {
  it('lists sign-ins by the list state, naming the user and the result', async () => {
    signedInWith({ 'Access.readAudit': true });
    const urls = signInsApi([
      entry('1'),
      entry('2', {
        result: 'failure',
        userName: null,
        userLabel: 'former@example.com',
      }),
    ]);
    await renderApp('/sign-ins?result=eq.failure&method=startsWith.pass');

    expect(await screen.findByText('Noah')).toBeInTheDocument();
    expect(screen.getByText('former@example.com')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    const last = urls.at(-1)!;
    expect(JSON.parse(last.searchParams.get('filter') ?? 'null')).toEqual({
      and: [
        { field: 'result', op: 'eq', value: 'failure' },
        { field: 'method', op: 'startsWith', value: 'pass' },
      ],
    });
  });

  it('is gated: no nav entry and a redirect without the permission', async () => {
    const groups = (can: Record<string, boolean>) =>
      visibleGroups(nav, allFeatures, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(groups({})).not.toContain('/sign-ins');
    expect(groups({ 'Access.readAudit': true })).toContain('/sign-ins');

    signedInWith({});
    const { router } = await renderApp('/sign-ins');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
