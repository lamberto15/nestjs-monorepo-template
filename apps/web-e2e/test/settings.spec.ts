import { expect, test, asRole } from './fixtures';

test.describe('the administrator', () => {
  test.use(asRole('administrator'));

  test('sees the settings page', async ({ page }) => {
    await page.goto('/settings');
    await expect(
      page.getByRole('heading', { name: 'Settings and flags' }),
    ).toBeVisible();
    await expect(
      page.getByRole('searchbox', { name: 'Search settings' }),
    ).toBeVisible();
  });
});

test.describe('a viewer', () => {
  test.use(asRole('viewer'));

  test('is sent away from the settings page', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL('/');
    await expect(
      page.getByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
  });
});
