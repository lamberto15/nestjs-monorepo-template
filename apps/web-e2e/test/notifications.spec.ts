import { expect, test, asRole } from './fixtures';

test.use(asRole('editor'));

test('the bell opens', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Notifications, \d+ unread$/ })
    .click();
  await expect(
    page.getByText('Notifications', { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open the inbox' }),
  ).toBeVisible();
});
