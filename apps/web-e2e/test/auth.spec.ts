import { account } from './accounts';
import { expect, test } from './fixtures';

// These tests sign in or out themselves: a fresh browser, no saved state. The
// account is a team lead, which nothing else signs in as, so the API's limit of
// 5 sign-ins per email per 15 minutes is spared.
test.use({ storageState: { cookies: [], origins: [] } });

const teamLead = () => account('team-lead');

test('signs in with a password and lands on the dashboard', async ({
  page,
}) => {
  const { email, password } = teamLead();
  await page.goto('/sign-in');
  await expect(page.getByText('Welcome back')).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('a wrong password is refused and stays on the form', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(teamLead().email);
  await page.getByLabel('Password').fill('not-the-password-1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('alert')).toBeVisible();
});

test('a deep link goes to sign-in and back after signing in', async ({
  page,
}) => {
  const { email, password } = teamLead();
  await page.goto('/notes');
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/notes');
  await expect(
    page.getByRole('heading', { name: 'Notes', level: 1 }),
  ).toBeVisible();
});

test('signs out', async ({ page }) => {
  const { email, password } = teamLead();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(email) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  // The session is gone: a protected page asks again.
  await page.goto('/notes');
  await expect(page).toHaveURL(/\/sign-in/);
});
