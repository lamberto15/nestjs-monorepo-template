import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { weekRanges, weekStart } from './dashboard-chart';

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

function useNotes(
  seen: { recent: string[]; weekly: string[] } = { recent: [], weekly: [] },
) {
  server.use(
    http.get('/v1/notes/dashboard/weekly-counts', ({ request }) => {
      const url = new URL(request.url);
      seen.weekly.push(url.search);
      const start = new Date(`${url.searchParams.get('from')}T00:00:00Z`);
      const weeks = Number(url.searchParams.get('weeks'));
      return HttpResponse.json(
        Array.from({ length: weeks }, (_, index) => {
          const week = new Date(start.getTime() + index * 7 * 24 * 3600 * 1000)
            .toISOString()
            .slice(0, 10);
          return { week, count: index === weeks - 1 ? 2 : 0 };
        }),
      );
    }),
    http.get('/v1/notes', ({ request }) => {
      const url = new URL(request.url);
      seen.recent.push(url.search);
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

describe('the notes on the dashboard', () => {
  it('shows the recent notes, the weekly chart and the new-note action', async () => {
    const seen = { recent: [], weekly: [] };
    useSignedIn(['Note.read', 'Note.create']);
    useNotes(seen);
    await renderApp('/');

    expect(
      await screen.findByRole('link', { name: 'Kickoff notes' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('heading', { name: 'Notes per week' }),
    ).toBeVisible();
    expect(seen.weekly).toHaveLength(1);
    expect(new URLSearchParams(seen.weekly[0]).get('weeks')).toBe('8');
    const quick = screen
      .getByRole('heading', { name: 'Quick actions' })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(quick).getByRole('button', { name: 'New note' }),
    ).toBeVisible();
  });

  it('names the week of a bar in its tooltip', async () => {
    // Gives the chart a size (jsdom measures none), so recharts draws it.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: { width: 480, height: 224 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    useSignedIn(['Note.read']);
    useNotes();
    await renderApp('/');

    const surface = await waitFor(() => {
      const found = document.querySelector<SVGElement>('.recharts-surface');
      expect(found).not.toBeNull();
      return found as SVGElement;
    });
    // jsdom's mouse can't aim at a bar; the keyboard can (`accessibilityLayer`).
    act(() => surface.focus());
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    const tooltip = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '.recharts-tooltip-wrapper',
      );
      expect(found?.textContent).toContain('Notes');
      return found as HTMLElement;
    });
    // The header names the week (its Monday); a `labelKey` made it vanish.
    const header = within(tooltip).getByText(/^\d{4}-\d{2}-\d{2}$/);
    expect(weekRanges().map((range) => range.week)).toContain(
      header.textContent,
    );
  });

  it('shows nothing of the notes without Note.read, and asks nothing', async () => {
    const seen = { recent: [], weekly: [] };
    useSignedIn([]);
    useNotes(seen);
    await renderApp('/');

    await screen.findByRole('heading', { name: 'Quick actions' });
    expect(
      screen.queryByRole('heading', { name: 'Recently changed notes' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Notes per week' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'New note' })).toBeNull();
    expect(seen).toEqual({ recent: [], weekly: [] });
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
