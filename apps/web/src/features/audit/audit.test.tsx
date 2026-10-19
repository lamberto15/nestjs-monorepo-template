import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { signedInWith } from '@/features/access/test/fixtures';
import { buildAuditQuery, noFilters } from '@/features/audit/api';
import { nav, visibleGroups } from '@/nav';
import { peopleHandler } from '@/test/people';
import { renderApp } from '@/test/render-app';
import { allFeatures, server } from '@/test/server';

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

function auditApi(items: object[], nextPage: number | null = null) {
  const urls: URL[] = [];
  server.use(
    http.get('/v1/access/audit', ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json({
        items,
        page: Number(url.searchParams.get('page') ?? 1),
        nextPage,
        total: items.length,
        pageCount: nextPage ? 2 : 1,
      });
    }),
  );
  return urls;
}

describe('the audit query', () => {
  it('sends nothing for empty filters but the page', () => {
    expect(buildAuditQuery(noFilters, 2)).toEqual({
      page: '2',
      limit: '25',
      count: 'true',
    });
  });

  it('maps the filters to the list route’s parameters', () => {
    const query = buildAuditQuery(
      {
        action: ' note. ',
        actor: 'user:u1',
        targetType: 'note',
        from: '2026-10-01',
        to: '2026-10-02',
      },
      1,
    );
    expect(query).toMatchObject({
      'action.startsWith': 'note.',
      actor: 'user:u1',
      targetType: 'note',
      // The viewer's days: from the start of the first to the start after the last.
      'at.gte': new Date(2026, 9, 1).toISOString(),
      'at.lt': new Date(2026, 9, 3).toISOString(),
    });
  });
});

describe('the audit log page', () => {
  it('lists entries, filters by action and pages on the server', async () => {
    signedInWith({ 'Access.readAudit': true });
    const urls = auditApi([entry('1')], 2);
    await renderApp('/audit');
    const user = userEvent.setup();

    expect(await screen.findByText('noah@example.com')).toBeInTheDocument();
    expect(urls[0]!.searchParams.get('page')).toBe('1');
    expect(urls[0]!.searchParams.has('action.startsWith')).toBe(false);

    await user.type(screen.getByLabelText('Action starts with'), 'client.');
    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await vi.waitFor(() => {
      const last = urls.at(-1)!;
      expect(last.searchParams.get('action.startsWith')).toBe('client.');
      expect(last.searchParams.get('at.gte')).toBe(
        new Date(2026, 9, 1).toISOString(),
      );
    });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await vi.waitFor(() =>
      expect(urls.at(-1)!.searchParams.get('page')).toBe('2'),
    );
    expect(urls.at(-1)!.searchParams.get('action.startsWith')).toBe('client.');
  });

  it('names an actor the entry stored no label for, in one request', async () => {
    signedInWith({ 'Access.readAudit': true });
    const ADA = '0199a3f2-0000-7000-8000-000000000011';
    const GRACE = '0199a3f2-0000-7000-8000-000000000012';
    const asked: URLSearchParams[] = [];
    server.use(
      peopleHandler(
        [
          { id: ADA, name: 'Noor Ahmed' },
          { id: GRACE, name: 'Grace Hopper' },
        ],
        [],
        asked,
      ),
    );
    auditApi([
      entry('1', { actor: `user:${ADA}`, actorLabel: null }),
      entry('2', { actor: `user:${GRACE}`, actorLabel: null }),
      entry('3', { actor: `user:${ADA}`, actorLabel: null }),
      entry('4', { actor: 'system:cleanup', actorLabel: null }),
      entry('5', { actor: 'user:u1' }),
    ]);
    await renderApp('/audit');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getAllByText('Noor Ahmed')).toHaveLength(2);
    // What the entry stored, or no person: as it is, and never asked for.
    expect(screen.getByText('system:cleanup')).toBeInTheDocument();
    expect(screen.getByText('noah@example.com')).toBeInTheDocument();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.get('key')?.split(',').sort()).toEqual(
      [`user:${ADA}`, `user:${GRACE}`].sort(),
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
      await screen.findByRole('button', {
        name: 'Show details of note.created',
      }),
    );
    const row = (await screen.findByText(/onerror/)).closest('pre')!;
    expect(row.querySelector('img')).toBeNull();
    // Shown as the JSON text it is: the markup is characters.
    expect(row).toHaveTextContent('<img src=x onerror=\\"alert(1)\\">');
    expect(within(row).queryByRole('img')).toBeNull();
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
