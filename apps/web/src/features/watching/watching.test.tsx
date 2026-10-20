import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { subscriptionsHandlers } from '@/test/subscriptions';
import { findToast } from '@/test/toast';

// A subject no feature registers a page for (the test-only one): listed by
// its name and id, with a stop button. A registered subject's link and title
// are tested with its feature (features/notes/notes-watch.test.tsx).
const row = (recordId: string, createdAt = '2026-10-17T09:00:00.000Z') => ({
  subject: 'TestItem',
  recordId,
  createdAt,
});

function useWatching(options: Parameters<typeof subscriptionsHandlers>[0]) {
  useSignedIn([]);
  const api = subscriptionsHandlers(options);
  server.use(...api.handlers);
  return api;
}

describe('the watching list', () => {
  it('lists what the user watches', async () => {
    useWatching({ watched: [row('rec-1'), row('rec-2')] });
    await renderApp('/account/watching');
    expect(
      await screen.findByRole('heading', { name: 'Watching' }),
    ).toBeVisible();
    expect(await screen.findByText('rec-1')).toBeVisible();
    expect(screen.getByText('rec-2')).toBeVisible();
    expect(screen.getAllByText(/^TestItem · since /)).toHaveLength(2);
  });

  it('says so when nothing is watched', async () => {
    useWatching({ watched: [] });
    await renderApp('/account/watching');
    expect(
      await screen.findByText('You are not watching any record.'),
    ).toBeVisible();
  });

  it('stops watching one record and drops its row', async () => {
    const api = useWatching({ watched: [row('rec-1'), row('rec-2')] });
    await renderApp('/account/watching');
    const user = userEvent.setup();
    await screen.findByText('rec-1');
    await user.click(
      screen.getByRole('button', { name: 'Stop watching rec-1' }),
    );
    await findToast('You stopped watching.');
    expect(api.calls.removed).toEqual(['TestItem/rec-1']);
    await waitFor(() =>
      expect(screen.queryByText('rec-1')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('rec-2')).toBeVisible();
  });

  it('loads further pages on request', async () => {
    useWatching({
      pageSize: 20,
      watched: Array.from({ length: 25 }, (_, i) => row(`rec-${i + 1}`)),
    });
    await renderApp('/account/watching');
    const user = userEvent.setup();
    await screen.findByText('rec-1');
    expect(screen.queryByText('rec-25')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('rec-25')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });
});
