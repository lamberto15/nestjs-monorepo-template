import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TEST_RECORD, panelHandlers } from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { subscriptionsHandlers } from '@/test/subscriptions';
import { findToast } from '@/test/toast';
import { WatchButton } from './watch-button';

// The Watch toggle on the test-only subject's record (no feature's page hosts
// it): it follows the API's `capabilities.watch`, and its state is the
// record's own `watching` (`?include=watching`), which the page passes in:
// the subscriptions list is never asked.
const ID = '0199a3f2-0000-7000-8000-000000000601';

/** What a page does: it holds the record's `watching` and sets it when told. */
function Page(props: {
  initial: boolean | undefined;
  onToggled: (watching: boolean) => void;
}) {
  const [watching, setWatching] = useState(props.initial);
  return (
    <WatchButton
      subject={TEST_RECORD.subject}
      path={TEST_RECORD.path}
      id={ID}
      watching={watching}
      onToggled={(next) => {
        props.onToggled(next);
        setWatching(next);
      }}
    />
  );
}

async function mount(options: {
  watch?: boolean;
  watching?: boolean | undefined;
  can?: string[];
}) {
  const panelsApi = panelHandlers({
    capabilities: { watch: options.watch ?? true },
  });
  const api = subscriptionsHandlers({
    watched: options.watching
      ? [{ subject: TEST_RECORD.subject, recordId: ID }]
      : [],
  });
  server.use(...panelsApi.handlers, ...api.handlers);
  const toggled: boolean[] = [];
  const view = await renderComponent(
    <Page
      initial={'watching' in options ? options.watching : false}
      onToggled={(watching) => toggled.push(watching)}
    />,
    { can: options.can ?? ['TestItem.read'] },
  );
  return {
    ...api,
    panels: panelsApi.calls,
    queryClient: view.queryClient,
    toggled,
  };
}

describe('the watch toggle', () => {
  it('watches the record, then stops, telling the page each time', async () => {
    const api = await mount({});
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Watch' }));
    await findToast('You are watching this record.');
    expect(api.calls.watched).toEqual([ID]);

    const stop = await screen.findByRole('button', { name: 'Stop watching' });
    await user.click(stop);
    await findToast('You stopped watching.');
    expect(api.calls.unwatched).toEqual([ID]);
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeVisible();
    expect(api.toggled).toEqual([true, false]);
  });

  it('shows a watched record as watched, without asking the subscriptions', async () => {
    const api = await mount({ watching: true });
    expect(
      await screen.findByRole('button', { name: 'Stop watching' }),
    ).toBeVisible();
    expect(api.calls.listed).toEqual([]);
  });

  it('shows nothing while the record does not say', async () => {
    const api = await mount({ watching: undefined });
    await waitFor(() =>
      expect(
        api.queryClient.getQueryData(['lists', TEST_RECORD.subject]),
      ).toBeDefined(),
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.calls.listed).toEqual([]);
  });

  it('is absent for a subject that does not take watching', async () => {
    const api = await mount({ watch: false });
    // The subject's description has arrived (it is what says no watching)…
    await waitFor(() =>
      expect(
        api.queryClient.getQueryData(['lists', TEST_RECORD.subject]),
      ).toBeDefined(),
    );
    await waitFor(() => expect(api.queryClient.isFetching()).toBe(0));
    // …and nothing was asked of the subscriptions, nor shown.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.calls.listed).toEqual([]);
  });

  it('is absent for a user who may not read the record', async () => {
    const api = await mount({ can: [] });
    await waitFor(() => expect(api.queryClient.isFetching()).toBe(0));
    // The description is not even asked for.
    expect(
      api.queryClient.getQueryData(['lists', TEST_RECORD.subject]),
    ).toBeUndefined();
    expect(api.panels.described).toBe(0);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.calls.listed).toEqual([]);
  });
});
