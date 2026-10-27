import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { useRetentionApi } from './test/retention-api';

const ADMIN = ['Access.manageRetention'];

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/retention');
    expect(entries({ 'Access.manageRetention': true })).toContain('/retention');
  });

  it('sends a user without the permission away, with no request', async () => {
    const { calls } = useRetentionApi({ can: ['TestItem.read'] });
    const { router } = await renderApp('/retention');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.reads).toBe(0);
  });
});

describe('the rules', () => {
  it('shows each rule with its switch, days, mode and last run, and the holds copy', async () => {
    useRetentionApi({ can: ADMIN });
    await renderApp('/retention');
    expect(await screen.findByText('Notes')).toBeVisible();
    expect(screen.getByText(/legal hold/)).toBeVisible();
    expect(screen.getByText('Purge')).toBeVisible();
    expect(screen.getByText('Anonymise')).toBeVisible();
    expect(
      screen.getByRole('switch', { name: 'Turn Notes on' }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Turn Contacts on' }),
    ).toBeChecked();
    expect(screen.getByLabelText('Days to keep Notes')).toHaveValue(730);
    expect(screen.getByLabelText('Days to keep Contacts')).toHaveValue(365);
    expect(screen.getByText(/12 handled/)).toBeVisible();
    expect(screen.getByText('Has not run yet.')).toBeVisible();
  });

  it('turns a rule on and sends the days', async () => {
    const { calls } = useRetentionApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/retention');
    await user.click(
      await screen.findByRole('switch', { name: 'Turn Notes on' }),
    );
    const days = screen.getByLabelText('Days to keep Notes');
    await user.clear(days);
    await user.type(days, '90');
    const card = days.closest('form')!;
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]).toEqual({
      name: 'note',
      body: { enabled: true, days: 90 },
    });
    await findToast('Rule “Notes” saved.');
  });

  it('refuses days below the minimum without asking the API', async () => {
    const { calls } = useRetentionApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/retention');
    const days = await screen.findByLabelText('Days to keep Notes');
    await user.clear(days);
    await user.type(days, '5');
    await user.click(
      within(days.closest('form')!).getByRole('button', { name: 'Save' }),
    );
    expect(
      await screen.findByText('Keep records for at least 30 days.'),
    ).toBeVisible();
    expect(calls.put).toEqual([]);
  });

  it('describes the days by their hint, then by why they are refused', async () => {
    useRetentionApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/retention');
    const days = await screen.findByLabelText('Days to keep Notes');
    const hint =
      'At least 30; the default is 730. Applied at the next nightly run.';
    expect(days).toHaveAccessibleDescription(hint);
    await user.clear(days);
    await user.type(days, '5');
    await user.click(
      within(days.closest('form')!).getByRole('button', { name: 'Save' }),
    );
    await screen.findByText('Keep records for at least 30 days.');
    expect(days).toBeInvalid();
    expect(days).toHaveAccessibleDescription(
      `${hint} Keep records for at least 30 days.`,
    );
  });

  it('keeps Save off until something changed', async () => {
    useRetentionApi({ can: ADMIN });
    await renderApp('/retention');
    await screen.findByText('Notes');
    for (const b of screen.getAllByRole('button', { name: 'Save' })) {
      expect(b).toBeDisabled();
    }
  });
});
