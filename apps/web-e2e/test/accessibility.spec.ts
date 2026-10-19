import { expect, test, asRole } from './fixtures';

// Serious and critical violations fail; all of them are attached to the test
// and listed in the job summary (scripts/axe-summary.mjs).
test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign-in', async ({ page, expectAccessible }) => {
    await page.goto('/sign-in');
    await expect(
      page.getByRole('button', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await expectAccessible(page, 'sign-in');
  });
});

test.describe('signed in as the administrator', () => {
  test.use(asRole('administrator'));

  test('dashboard', async ({ page, expectAccessible }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
    await expectAccessible(page, 'dashboard');
  });

  test('notes list', async ({ page, expectAccessible }) => {
    await page.goto('/notes');
    await expect(page.getByRole('row').nth(1).getByRole('link')).toBeVisible();
    await expectAccessible(page, 'notes-list');
  });

  test('note detail', async ({ page, expectAccessible }) => {
    await page.goto('/notes');
    await page.getByRole('row').nth(1).getByRole('link').click();
    await expect(
      page.getByRole('link', { name: 'Back to notes' }),
    ).toBeVisible();
    await expectAccessible(page, 'note-detail');
  });

  test('settings', async ({ page, expectAccessible }) => {
    await page.goto('/settings');
    await expect(
      page.getByRole('heading', { name: 'Settings and flags' }),
    ).toBeVisible();
    await expectAccessible(page, 'settings');
  });
});
