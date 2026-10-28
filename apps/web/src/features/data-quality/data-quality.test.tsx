import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { useDataQualityApi } from './test/data-quality-api';

const READER = ['DataQuality.read'];
const MANAGER = ['DataQuality.read', 'DataQuality.manage'];

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/data-quality');
    expect(entries({ 'DataQuality.read': true })).toContain('/data-quality');
  });

  it('sends a user without the permission away, with no request', async () => {
    const { calls } = useDataQualityApi({ can: ['TestItem.read'] });
    const { router } = await renderApp('/data-quality');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.reads).toBe(0);
  });
});

describe('the dashboard', () => {
  it('shows the counts, how fresh they are and the findings, without actions for a reader', async () => {
    useDataQualityApi({ can: READER });
    await renderApp('/data-quality');
    expect(
      await screen.findByText(/Finished .*: 2 open findings\./),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'TestItem' })).toBeVisible();
    expect(await screen.findByText('body is empty')).toBeVisible();
    expect(
      screen.getByText('parentId refers to a record in the recycle bin (abc)'),
    ).toBeVisible();
    expect(screen.getByText('Error')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Scan now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).toBeNull();
  });

  it('says when there was no scan yet', async () => {
    useDataQualityApi({ can: READER, lastScan: null, findings: [] });
    await renderApp('/data-quality');
    expect(
      await screen.findByText('No scan yet: start one to find problems.'),
    ).toBeVisible();
    expect(await screen.findByText('No open findings.')).toBeVisible();
  });

  it('starts a scan and shows its progress', async () => {
    const { calls } = useDataQualityApi({ can: MANAGER });
    const user = userEvent.setup();
    await renderApp('/data-quality');
    await user.click(await screen.findByRole('button', { name: 'Scan now' }));
    await findToast('Scan started.');
    expect(calls.scans).toBe(1);
    expect(
      await screen.findByText('Scanning: 3 of 12 records checked.'),
    ).toBeVisible();
    expect(
      screen.getByRole('progressbar', { name: 'Scan progress' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Scan now' })).toBeDisabled();
  });

  it('dismisses a finding, then shows it among the dismissed ones', async () => {
    const { calls } = useDataQualityApi({ can: MANAGER });
    const user = userEvent.setup();
    await renderApp('/data-quality');
    await user.click(
      await screen.findByRole('button', { name: 'Dismiss: body is empty' }),
    );
    await findToast('Finding dismissed.');
    expect(calls.dismissed).toEqual(['0198a000-0000-7000-8000-000000000001']);
    await waitFor(() => expect(screen.queryByText('body is empty')).toBeNull());
    await user.click(screen.getByRole('switch', { name: 'Show dismissed' }));
    expect(await screen.findByText('body is empty')).toBeVisible();
  });

  it('rechecks a finding and says it is resolved', async () => {
    const { calls } = useDataQualityApi({ can: MANAGER });
    const user = userEvent.setup();
    await renderApp('/data-quality');
    await user.click(
      await screen.findByRole('button', { name: 'Recheck: body is empty' }),
    );
    await findToast('Resolved: the problem is gone.');
    expect(calls.rechecked).toEqual(['0198a000-0000-7000-8000-000000000001']);
  });
});
