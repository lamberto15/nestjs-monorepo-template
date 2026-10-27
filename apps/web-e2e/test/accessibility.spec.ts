import type { Page } from '@playwright/test';
import { account } from './accounts';
import { expect, test, asRole } from './fixtures';

// Serious and critical violations fail, and so do the landmark, heading and
// skip-link rules (LANDMARK_RULES in fixtures.ts); all of them are attached to
// the test and listed in the job summary (scripts/axe-summary.mjs).

// The page's own h1 is what a scan waits for: the route has rendered.
const pageHeading = (page: Page) =>
  page.getByRole('heading', { level: 1 }).first();

const SIGNED_OUT = ['/sign-in', '/sign-up', '/forgot-password'];

const SIGNED_IN = [
  '/',
  '/notes',
  '/notes/new',
  '/settings',
  '/account/profile',
  '/account/preferences',
  '/account/security',
  '/account/notifications',
  '/account/privacy',
  '/account/watching',
];

/** A scan name from a path: "/account/profile" becomes "account-profile". */
const nameOf = (path: string, variant = '') =>
  [path.replace(/^\/|\/$/g, '').replaceAll('/', '-') || 'dashboard', variant]
    .filter(Boolean)
    .join('-');

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of SIGNED_OUT) {
    test(path, async ({ page, expectAccessible }) => {
      await page.goto(path);
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, nameOf(path));
    });
  }

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('sign-in', async ({ page, expectAccessible }) => {
      await page.goto('/sign-in');
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, 'sign-in-phone');
    });
  });

  test.describe('in Arabic', () => {
    test('sign-in', async ({ page, expectAccessible }) => {
      // The language the browser remembers (src/i18n.ts): no account involved.
      await page.addInitScript(() => localStorage.setItem('language', 'ar'));
      await page.goto('/sign-in');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, 'sign-in-arabic');
    });
  });
});

test.describe('signed in as the administrator', () => {
  test.use(asRole('administrator'));

  test('note detail', async ({ page, expectAccessible }) => {
    await page.goto('/notes');
    await page.getByRole('row').nth(1).getByRole('link').click();
    await expect(
      page.getByRole('link', { name: 'Back to notes' }),
    ).toBeVisible();
    await expect(pageHeading(page)).toBeVisible();
    await expectAccessible(page, 'note-detail');
  });

  for (const path of SIGNED_IN) {
    test(path, async ({ page, expectAccessible }) => {
      await page.goto(path);
      await expect(pageHeading(page)).toBeVisible();
      await expectAccessible(page, nameOf(path));
    });
  }

  test.describe('dark theme', () => {
    test.beforeEach(async ({ page }) => {
      // The theme the browser remembers (the ThemeProvider's storage key).
      await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    });

    for (const path of ['/', '/notes', '/settings']) {
      test(path, async ({ page, expectAccessible }) => {
        await page.goto(path);
        await expect(page.locator('html')).toHaveClass(/dark/);
        await expect(pageHeading(page)).toBeVisible();
        await expectAccessible(page, nameOf(path, 'dark'));
      });
    }
  });

  test.describe('in Arabic (right to left)', () => {
    test.beforeEach(async ({ page }) => {
      // The account's language comes with /v1/auth/me; answering it in Arabic
      // here leaves the shared account (and the other tests) as they are.
      await page.route('**/v1/auth/me', async (route) => {
        if (route.request().method() !== 'GET') {
          return route.fallback();
        }
        const response = await route.fetch();
        const body = (await response.json()) as { user: { locale: string } };
        body.user.locale = 'ar';
        return route.fulfill({ response, json: body });
      });
    });

    for (const path of ['/', '/notes', '/settings']) {
      test(path, async ({ page, expectAccessible }) => {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(pageHeading(page)).toBeVisible();
        await expectAccessible(page, nameOf(path, 'arabic'));
      });
    }
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    for (const path of ['/', '/notes', '/account/profile']) {
      test(path, async ({ page, expectAccessible }) => {
        await page.goto(path);
        await expect(pageHeading(page)).toBeVisible();
        await expectAccessible(page, nameOf(path, 'phone'));
      });
    }
  });

  // Reflow (WCAG 1.4.10): narrowing the window (or zooming in) under the
  // two-column breakpoint, the dashboard's chart shrinks with it rather than
  // keeping its width and scrolling the page sideways.
  test('the dashboard reflows when the window narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('[data-slot="chart"] svg')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
  });

  // A wide table scrolls inside its own box, never the page (the box shows
  // edge shadows to say so: `scroll-shadow-x`).
  test('a table scrolls sideways on a phone, not the page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/notes');
    const box = page.locator('[data-slot="table-container"]').first();
    await expect(box).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
    await expect
      .poll(() => box.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeGreaterThan(0);
  });

  test.describe('open overlays', () => {
    // Only what the overlay holds is scanned: the page behind it is inert
    // while a modal is open, and the page-level rules are covered above.
    test('the search dialog', async ({ page, expectAccessible }) => {
      await page.goto('/');
      await expect(pageHeading(page)).toBeVisible();
      await page.getByRole('button', { name: 'Search (Ctrl+K)' }).click();
      await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
      await expectAccessible(page, 'search-dialog', {
        scope: '[role="dialog"]',
      });
    });

    test('the filter popover', async ({ page, expectAccessible }) => {
      await page.goto('/notes');
      await expect(pageHeading(page)).toBeVisible();
      await page.getByRole('button', { name: 'Filter' }).first().click();
      await page.getByRole('button', { name: 'Add filter' }).click();
      await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
      await expectAccessible(page, 'filter-popover', {
        scope: '[role="dialog"]',
      });
    });

    test('the user menu', async ({ page, expectAccessible }) => {
      await page.goto('/');
      await expect(pageHeading(page)).toBeVisible();
      await page
        .getByRole('button', { name: account('administrator').email })
        .click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expectAccessible(page, 'user-menu', { scope: '[role="menu"]' });
    });
  });
});
