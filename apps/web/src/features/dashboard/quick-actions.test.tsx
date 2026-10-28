import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';

// A feature's action whose label is a bare key: the menu's contract is that it
// resolves in `common` (here `nav.dashboard`), as `ns:key` names a namespace.
vi.mock('./registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('./registry')>();
  const { HouseIcon } = await import('lucide-react');
  return {
    ...original,
    dashboard: {
      ...original.dashboard,
      actions: [
        ...original.dashboard.actions,
        { to: '/', order: 99, label: 'nav.dashboard', icon: HouseIcon },
      ],
    },
  };
});

describe('the quick actions', () => {
  it('translate a bare label in common, and a namespaced one in its namespace', async () => {
    useSignedIn([]);
    await renderApp('/');

    const quick = (
      await screen.findByRole('heading', { name: 'Quick actions' })
    ).closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(quick).getByRole('button', { name: 'Dashboard' }),
    ).toBeVisible();
    expect(within(quick).getByRole('button', { name: 'Inbox' })).toBeVisible();
  });
});
