import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { PresenceIndicator } from './presence-indicator';

const approval = {
  key: 'approval:a1',
  source: 'approval',
  kind: 'approval.decide',
  at: '2026-10-28T00:00:00.000Z',
  dueAt: null,
  link: '/approvals/a1',
  subject: 'Note',
  recordId: 'n1',
  data: { title: 'Q4 plan', requester: 'Ada', action: 'publish' },
  canDismiss: false,
};
const mention = {
  ...approval,
  key: 'mention:m1',
  source: 'mention',
  kind: 'mention',
  link: '/notes/n1',
  data: { title: 'Budget', by: 'Bob', excerpt: 'look' },
  canDismiss: true,
};

describe('my work', () => {
  it('lists what waits on the person and dismisses a mention', async () => {
    useSignedIn([]);
    let items = [approval, mention];
    const dismissed: unknown[] = [];
    server.use(
      http.get('/v1/inbox', () =>
        HttpResponse.json({ items, nextCursor: null }),
      ),
      http.post('/v1/inbox/dismiss', async ({ request }) => {
        dismissed.push(await request.json());
        items = [approval];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    await renderApp('/work');
    expect(await screen.findByText('Q4 plan')).toBeVisible();
    expect(screen.getByText('Requested by Ada')).toBeVisible();
    expect(screen.getByText('Bob mentioned you')).toBeVisible();
    // Only a mention is dismissed here; an approval is done by deciding it.
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismissed).toEqual([{ key: 'mention:m1' }]));
    await waitFor(() => expect(screen.queryByText('Budget')).toBeNull());
  });
});

describe('record presence', () => {
  const people = (items: object[]) =>
    http.put('/v1/presence/:subject/:recordId', () =>
      HttpResponse.json({ items }),
    );

  it('shows the others on the record and warns about an editor', async () => {
    server.use(
      people([
        { key: 'user:me', name: 'Me', mode: 'viewing', self: true },
        { key: 'user:ada', name: 'Ada', mode: 'editing', self: false },
      ]),
      http.get('/v1/presence/:subject/:recordId', () =>
        HttpResponse.json({ items: [] }),
      ),
      http.delete(
        '/v1/presence/:subject/:recordId',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await renderComponent(
      <PresenceIndicator subject="Note" recordId="n1" mode="viewing" />,
    );
    expect(await screen.findByText('Ada is editing')).toBeVisible();
    expect(screen.queryByText('Me is viewing')).toBeNull();
    expect(screen.getByText(/Someone is editing this record/)).toBeVisible();
  });

  it('shows nothing when the person is alone', async () => {
    server.use(
      people([{ key: 'user:me', name: 'Me', mode: 'viewing', self: true }]),
      http.get('/v1/presence/:subject/:recordId', () =>
        HttpResponse.json({ items: [] }),
      ),
      http.delete(
        '/v1/presence/:subject/:recordId',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await renderComponent(
      <PresenceIndicator subject="Note" recordId="n1" mode="viewing" />,
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
