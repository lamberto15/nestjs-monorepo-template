import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TEST_RECORD, panelHandlers } from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { subscriptionsHandlers } from '@/test/subscriptions';
import { findToast } from '@/test/toast';
import { WatchButton } from './watch-button';

// The Watch toggle on the test-only subject's record (no feature's page hosts
// it): it follows the API's `capabilities.watch`, and the state is the
// subscriptions list filtered to the record.
const ID = '0199a3f2-0000-7000-8000-000000000601';

async function mount(options: {
  watch?: boolean;
  watched?: boolean;
  can?: string[];
}) {
  const panelsApi = panelHandlers({
    capabilities: { watch: options.watch ?? true },
  });
  const api = subscriptionsHandlers({
    watched: options.watched
      ? [{ subject: TEST_RECORD.subject, recordId: ID }]
      : [],
  });
  server.use(...panelsApi.handlers, ...api.handlers);
  await renderComponent(
    <WatchButton
      subject={TEST_RECORD.subject}
      path={TEST_RECORD.path}
      id={ID}
    />,
    { can: options.can ?? ['TestItem.read'] },
  );
  return { ...api, panels: panelsApi.calls };
}

describe('the watch toggle', () => {
  it('watches the record, then stops', async () => {
    const api = await mount({});
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Watch' }));
    await findToast('You are watching this record.');
    expect(api.calls.watched).toEqual([ID]);

    const stop = await screen.findByRole('button', { name: 'Stop watching' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    await user.click(stop);
    await findToast('You stopped watching.');
    expect(api.calls.unwatched).toEqual([ID]);
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeVisible();
  });

  it('shows a watched record as watched', async () => {
    const api = await mount({ watched: true });
    expect(
      await screen.findByRole('button', { name: 'Stop watching' }),
    ).toBeVisible();
    // The state is asked of the list, filtered to this record.
    expect(api.calls.listed[0]).toContain(`recordId=${ID}`);
    expect(api.calls.listed[0]).toContain('subject=TestItem');
  });

  it('is absent for a subject that does not take watching', async () => {
    const api = await mount({ watch: false });
    // Wait for the subject's description (what says it takes no watching).
    await vi.waitFor(() => expect(api.panels.described).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.calls.listed).toEqual([]);
  });

  it('is absent for a user who may not read the record', async () => {
    const api = await mount({ can: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.calls.listed).toEqual([]);
    expect(api.panels.described).toBe(0);
  });
});
