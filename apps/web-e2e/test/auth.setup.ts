import { account, stateFile, type Role } from './accounts';
import { expect, test as setup } from './fixtures';

// Each role signs in once through the form; every test file then starts from
// its saved state (docs: playwright.dev/docs/auth). The API limits sign-ins to
// 5 per email per 15 minutes, which a sign-in per test would pass.
for (const role of [
  'administrator',
  'editor',
  'viewer',
] as const satisfies Role[]) {
  setup(`sign in as the ${role}`, async ({ page }) => {
    const { email, password } = account(role);
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible();
    await page.context().storageState({ path: stateFile(role) });
  });
}
