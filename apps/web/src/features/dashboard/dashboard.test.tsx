import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { FilePlusIcon } from 'lucide-react';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { mergeDashboard } from './registry';

const approval = {
  id: '0199a3f2-0000-7000-8000-0000000000b1',
  title: 'Publish the Q4 plan',
  requesterName: 'Grace Hopper',
  createdAt: new Date().toISOString(),
  status: 'pending',
};

/** Answers the routes of the cards that need no permission, and the audit's. */
function useData(seen: string[] = []) {
  server.use(
    http.get('/v1/settings', () =>
      HttpResponse.json({
        items: [
          {
            key: 'dashboard.layout',
            label: 'Dashboard layout',
            description:
              'Which dashboard cards you hide and the order you prefer.',
            flag: false,
            scopes: ['user'],
            public: true,
            value: { hidden: [], order: [] },
            source: 'default',
            default: { hidden: [], order: [] },
            type: 'json',
            schema: {},
            canEdit: false,
            canSetMine: true,
            platform: null,
            canEditPlatform: false,
          },
        ],
      }),
    ),
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
  );
}

const cardOf = (name: string) =>
  screen.getByRole('heading', { name }).closest('[data-slot="card"]');

describe('the dashboard', () => {
  it('shows the cards of the features to a user who may see them', async () => {
    const seen: string[] = [];
    useSignedIn(['Access.readAudit']);
    useData(seen);
    await renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('link', { name: 'Publish the Q4 plan' }),
    ).toBeVisible();
    // The approvals' total, from `count=true`.
    expect(await screen.findByText('Assigned to you: 3')).toBeVisible();
    expect(await screen.findByText('Welcome aboard')).toBeVisible();
    expect(await screen.findByText('Unread: 7')).toBeVisible();
    expect(await screen.findByText('Noah Kim')).toBeVisible();
    // The event as people read it, with its key on hover.
    expect(await screen.findByTitle('note.created')).toHaveTextContent(
      'Note created',
    );
    expect(seen.some((entry) => entry.includes('assignedToMe=true'))).toBe(
      true,
    );

    const quick = cardOf('Quick actions') as HTMLElement;
    expect(
      within(quick).getByRole('button', { name: 'Approvals' }),
    ).toBeVisible();
    expect(
      within(quick).getByRole('button', { name: 'Audit log' }),
    ).toBeVisible();
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
    const quick = cardOf('Quick actions') as HTMLElement;
    expect(
      within(quick).queryByRole('button', { name: 'Audit log' }),
    ).toBeNull();
    expect(
      within(quick).getByRole('button', { name: 'Notifications' }),
    ).toBeVisible();
    expect(seen).not.toContain('audit');
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

describe('the dashboard registry', () => {
  it('sorts the cards and actions of every feature by order', () => {
    const component = () => null;
    const { cards, actions } = mergeDashboard([
      {
        cards: [
          { id: 'b', label: 'b', order: 20, component },
          { id: 'a', label: 'a', order: 20, component },
        ],
        actions: [
          { to: '/approvals', order: 2, label: 'x', icon: FilePlusIcon },
        ],
      },
      {
        cards: [{ id: 'c', label: 'c', order: 10, component }],
        actions: [{ to: '/audit', order: 1, label: 'y', icon: FilePlusIcon }],
      },
      {},
    ]);
    expect(cards.map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(actions.map((a) => a.to)).toEqual(['/audit', '/approvals']);
  });
});
