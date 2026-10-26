import { account } from './accounts';
import { expect, test } from './fixtures';

// Issue #555: the tabs of one browser share the __Host-sid cookie, so when
// one of them changes the session's identity — a tenant switch, another
// account, an impersonation, every one a re-issued cookie — the others must
// forget the previous session's cached data at once (announced over a
// BroadcastChannel, lib/session-bus.ts), not keep it until their next
// refetch of `me` (fresh for a minute). An impersonation is the identity
// change the seeded demo data supports; a tenant switch is the same
// mechanism (the same reset and announcement, lib/session.ts).
//
// A fresh browser, signed in here: the impersonation re-issues the cookie
// of this test's own session, and the saved states of the other specs are
// left alone (their sessions are not this one's).

test.use({ storageState: { cookies: [], origins: [] } });

test('a session change in another tab resets this one', async ({ page }) => {
  const viewer = account('editor');
  const administrator = account('administrator');
  const footer = page.locator('[data-slot="sidebar-footer"]');
  const actingAs = (p: typeof page) => p.getByText('You are acting as');

  // This tab: signs in, and lands on the dashboard of its own session.
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(administrator.email);
  await page.getByLabel('Password').fill(administrator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(footer.getByText(administrator.email)).toBeVisible();
  await expect(actingAs(page)).toHaveCount(0);

  // Keep a user-entered note draft mounted in this tab while the second tab
  // changes the shared cookie. The first submit must be held and preserve
  // both fields until the user makes the deliberate second submission.
  await page.goto('/notes/new');
  await page.getByLabel('Title').fill('Draft from the previous identity');
  await page.getByLabel('Text').fill('Keep these unsaved words');

  // Another tab of this browser (the same cookie jar) impersonates the
  // viewer: the cookie is re-issued, that tab's flow resets its cache and
  // announces the new identity.
  const other = await page.context().newPage();
  await other.goto('/access/users');
  const row = other.getByRole('row').filter({ hasText: viewer.email });
  // The member sheet (the row's actions menu) holds the button.
  await row.getByRole('button', { name: /Open actions for row/ }).click();
  await other.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await other
    .getByRole('dialog')
    .getByRole('button', { name: 'Impersonate' })
    .click();
  await other
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Impersonate' })
    .click();

  // A stale sign-in would be asked to confirm it's the administrator again
  // (403 `reauthentication_required`; lib/api.ts sends it once more).
  const reauth = other.getByRole('dialog', { name: "Confirm it's you" });
  await expect(actingAs(other).or(reauth)).toBeVisible();
  if (await reauth.isVisible()) {
    await reauth.getByLabel('Password').fill(administrator.password);
    await reauth.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(actingAs(other)).toBeVisible();
  await other.close();

  // This tab never reloaded and navigated nowhere: the announced identity
  // resets its cache, and the `me` refetch under the re-issued cookie shows
  // the impersonated session — the banner and the user menu, live.
  await expect(actingAs(page)).toBeVisible();
  await expect(actingAs(page)).toContainText(viewer.email);
  await expect(footer.getByText(viewer.email)).toBeVisible();
  let posted = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/notes')) {
      posted = true;
    }
  });
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Nothing was sent');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Create note' }).click();
  await expect(page.getByLabel('Title')).toHaveValue(
    'Draft from the previous identity',
  );
  await expect(page.getByLabel('Text')).toHaveValue('Keep these unsaved words');
  expect(posted).toBe(false);
});

test('another account signing in in a second tab updates the open tab', async ({
  page,
}) => {
  const administrator = account('administrator');
  const editor = account('editor');
  const footer = page.locator('[data-slot="sidebar-footer"]');

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(administrator.email);
  await page.getByLabel('Password').fill(administrator.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const other = await page.context().newPage();
  await other.goto('/');
  const signedOut = await other.evaluate(async () => {
    const response = await fetch('/v1/auth/sign-out', { method: 'POST' });
    return response.ok;
  });
  expect(signedOut).toBe(true);
  await other.goto('/sign-in');
  await other.getByLabel('Email').fill(editor.email);
  await other.getByLabel('Password').fill(editor.password);
  await other.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // The first tab stays open at the same URL; the server-verified identity
  // changes to the account whose sign-in re-issued the shared cookie.
  await expect(footer.getByText(editor.email)).toBeVisible();
  await other.close();
});
