import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSignedIn } from '@/test/signed-in';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { weekRanges, weekStart } from './api';

beforeEach(() => {
  // jsdom has no ResizeObserver, which recharts' container needs.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const approval = {
  id: '0199a3f2-0000-7000-8000-0000000000b1',
  title: 'Publish the Q4 plan',
  requesterName: 'Grace Hopper',
  createdAt: new Date().toISOString(),
  status: 'pending',
};

/** Answers every route the dashboard asks, with a little data. */
function useData(seen: string[] = []) {
  server.use(
    http.get('/v1/approvals', ({ request }) => {
      seen.push(`approvals ${new URL(request.url).search}`);
      return HttpResponse.json({
        items: [approval],
        nextCursor: null,
        total: 3,
      });
    }),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 7 }),
    ),
    http.get('/v1/notifications', () =>
      HttpResponse.json({
        items: [
          {
            id: 'n1',
            type: 'x',
            title: 'Welcome aboard',
            body: 'Say hello',
            read: false,
            link: null,
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      }),
    ),
    http.get('/v1/access/audit', () => {
      seen.push('audit');
      return HttpResponse.json({
        items: [
          {
            id: 'a1',
            at: new Date().toISOString(),
            actor: 'user:u1',
            actorLabel: 'noah@example.com',
            actorName: 'Noah Kim',
            action: 'note.created',
          },
        ],
        nextCursor: null,
      });
    }),
    http.get('/v1/notes', ({ request }) => {
      const url = new URL(request.url);
      seen.push(`notes ${url.search}`);
      if (url.searchParams.has('createdAt.between')) {
        return HttpResponse.json({ items: [], nextCursor: null, total: 2 });
      }
      return HttpResponse.json({
        items: [
          {
            id: '0199a3f2-0000-7000-8000-0000000000c1',
            number: 'NOTE-2026-1',
            title: 'Kickoff notes',
            status: 'draft',
            updatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
    }),
  );
}

describe('the dashboard', () => {
  it('shows every card to a user who may see them all', async () => {
    const seen: string[] = [];
    useSignedIn(['Access.readAudit', 'Note.read', 'Note.create']);
    useData(seen);
    await renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
    const waiting = await screen.findByRole('heading', {
      name: 'Waiting for your approval',
    });
    expect(waiting).toBeVisible();
    expect(
      await screen.findByRole('link', { name: 'Publish the Q4 plan' }),
    ).toBeVisible();
    expect(await screen.findByText('Welcome aboard')).toBeVisible();
    expect(await screen.findByText('Noah Kim')).toBeVisible();
    expect(
      await screen.findByRole('link', { name: 'Kickoff notes' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Notes per week' }),
    ).toBeVisible();
    // The stats: the approvals' total and the bell's unread count.
    expect(await screen.findByText('7')).toBeVisible();
    expect(await screen.findAllByText('3')).not.toHaveLength(0);
    const quick = screen
      .getByRole('heading', { name: 'Quick actions' })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(quick).getByRole('button', { name: 'New note' }),
    ).toBeVisible();
    expect(
      within(quick).getByRole('button', { name: 'Audit log' }),
    ).toBeVisible();
    // One count request per week of the chart.
    expect(
      seen.filter((entry) => entry.includes('createdAt.between')),
    ).toHaveLength(8);
    expect(seen.some((entry) => entry.includes('assignedToMe=true'))).toBe(
      true,
    );
  });

  it('hides the cards the user has no permission for, and asks nothing for them', async () => {
    const seen: string[] = [];
    useSignedIn([]);
    useData(seen);
    await renderApp('/');

    await screen.findByRole('heading', { name: 'Waiting for your approval' });
    expect(
      screen.queryByRole('heading', { name: 'Recent activity' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Recently changed notes' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Notes per week' }),
    ).toBeNull();
    const quick = screen
      .getByRole('heading', { name: 'Quick actions' })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(quick).queryByRole('button', { name: 'New note' }),
    ).toBeNull();
    expect(
      within(quick).queryByRole('button', { name: 'Audit log' }),
    ).toBeNull();
    expect(
      within(quick).getByRole('button', { name: 'Approvals' }),
    ).toBeVisible();
    expect(
      seen.filter((entry) => entry === 'audit' || entry.startsWith('notes')),
    ).toEqual([]);
  });

  it('says so when nothing waits', async () => {
    useSignedIn([]);
    await renderApp('/');
    expect(
      await screen.findByText('Nothing is waiting for you.'),
    ).toBeVisible();
    expect(await screen.findByText('You are all caught up.')).toBeVisible();
  });
});

describe('the weeks of the chart', () => {
  it('start on Monday (UTC) and end on the Sunday before the next', () => {
    const wednesday = new Date('2026-10-21T10:00:00Z');
    expect(weekStart(wednesday).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    const ranges = weekRanges(wednesday, 3);
    expect(ranges.map((r) => r.week)).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(ranges[2]?.to).toBe('2026-10-25T23:59:59.999Z');
    expect(weekStart(new Date('2026-10-25T23:59:59Z')).toISOString()).toBe(
      '2026-10-19T00:00:00.000Z',
    );
  });
});
