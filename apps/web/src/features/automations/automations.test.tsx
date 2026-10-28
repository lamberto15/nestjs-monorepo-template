import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { RULE_ID, rule, useAutomationsApi } from './test/automations-api';

const ADMIN = ['AutomationRule.read', 'AutomationRule.manage'];

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/automations');
    expect(entries({ 'AutomationRule.read': true })).toContain('/automations');
  });

  it('sends a user without the permission away', async () => {
    useAutomationsApi({ can: ['Note.read'] });
    const { router } = await renderApp('/automations');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('shows the rules read-only without AutomationRule.manage', async () => {
    useAutomationsApi({ can: ['AutomationRule.read'] });
    await renderApp('/automations');
    expect(await screen.findByText('Tag urgent notes')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });
});

describe('the rules', () => {
  it('activates a draft, and shows a rule’s failed runs', async () => {
    const { calls } = useAutomationsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/automations');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Draft')).toBeVisible();
    await user.click(within(table).getByRole('button', { name: 'Activate' }));
    await findToast('Tag urgent notes is active.');
    expect(calls.activated).toEqual([RULE_ID]);
    expect(await within(table).findByText('Active')).toBeVisible();

    await user.click(
      screen.getByRole('button', { name: 'Runs of Tag urgent notes' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Failed')).toBeVisible();
    expect(within(dialog).getByText('notify: no_recipient')).toBeVisible();
  });

  it('shows why a rule was disabled', async () => {
    useAutomationsApi({
      can: ADMIN,
      rules: [rule({ status: 'disabled', disabledReason: 'failing' })],
    });
    await renderApp('/automations');
    expect(await screen.findByText('kept failing')).toBeVisible();
  });
});

describe('the builder', () => {
  it('simulates a draft without saving it, then saves it', async () => {
    const { calls } = useAutomationsApi({ can: ADMIN, rules: [] });
    const user = userEvent.setup();
    await renderApp('/automations');
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Shout');
    await user.click(
      within(dialog).getByRole('button', { name: 'Add a condition' }),
    );
    await user.type(within(dialog).getByLabelText('Filter'), 'title.contains');
    await user.type(within(dialog).getAllByLabelText('Value')[0]!, 'urgent');
    await user.click(within(dialog).getByRole('combobox', { name: 'Field' }));
    await user.click(await screen.findByRole('option', { name: 'title' }));
    await user.type(within(dialog).getAllByLabelText('Value')[1]!, 'Urgent');

    await user.click(within(dialog).getByRole('button', { name: 'Simulate' }));
    const result = await within(dialog).findByRole('region', {
      name: 'Simulation',
    });
    expect(within(result).getByText('An urgent note')).toBeVisible();
    expect(within(result).getByText('title = "Urgent"')).toBeVisible();
    expect(calls.simulated).toEqual([
      {
        subject: 'Note',
        trigger: 'created',
        field: null,
        filters: { 'title.contains': 'urgent' },
        actions: [{ type: 'setField', field: 'title', value: 'Urgent' }],
        limit: 20,
      },
    ]);
    expect(calls.created).toEqual([]);

    await user.click(
      within(dialog).getByRole('button', { name: 'Save the draft' }),
    );
    await findToast('Rule saved as a draft.');
    expect(calls.created).toEqual([
      {
        name: 'Shout',
        subject: 'Note',
        trigger: 'created',
        field: null,
        filters: { 'title.contains': 'urgent' },
        actions: [{ type: 'setField', field: 'title', value: 'Urgent' }],
      },
    ]);
  });
});
