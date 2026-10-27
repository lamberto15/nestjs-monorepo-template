import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { signedInWith } from '@/features/access/test/fixtures';
import { axeViolations } from '@/test/axe';
import { renderApp } from '@/test/render-app';
import { signedInUser } from '@/test/server';

// What the browser scans of apps/web-e2e find on every signed-in page, caught
// here without a browser (axe-core in jsdom: no layout, so no contrast).
describe('the signed-in shell', () => {
  it('puts the menu in landmarks and leaves no page content outside them (axe "region")', async () => {
    signedInWith({});
    await renderApp('/');
    const menu = await screen.findByRole('navigation', { name: 'Main menu' });
    expect(
      within(menu).getByRole('link', { name: 'Dashboard' }),
    ).toBeInTheDocument();
    // The menu's group labels are inside the navigation too.
    expect(
      menu.querySelector('[data-slot="sidebar-group-label"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole('complementary', { name: 'Sidebar' }),
    ).toContainElement(menu);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(await axeViolations(['region'])).toEqual([]);
  });

  it('opens a user menu that owns only items and groups (axe "aria-required-children")', async () => {
    signedInWith({});
    await renderApp('/');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(signedInUser.user.name),
      }),
    );
    const menu = await screen.findByRole('menu');
    expect(menu.querySelector(':scope > div[aria-label]')).toBeNull();
    expect(await axeViolations(['aria-required-children'], menu)).toEqual([]);
  });
});
