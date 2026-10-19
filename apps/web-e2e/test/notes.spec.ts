import { expect, test, asRole } from './fixtures';

test.use(asRole('editor'));

// Enough notes for a second page (20 a page), made once through the API as the
// signed-in editor; a rerun finds them.
const PAGED = 'E2E paging';
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext(asRole('editor'));
  const list = await context.request.get(
    '/v1/notes?q=' + encodeURIComponent(PAGED),
  );
  const { items } = (await list.json()) as { items: unknown[] };
  for (let n = items.length; n < 25; n++) {
    const created = await context.request.post('/v1/notes', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: {
        title: `${PAGED} ${String(n).padStart(2, '0')}`,
        body: 'Made for the paging test.',
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
  }
  await context.close();
});

test('the list loads and pages on the server', async ({ page }) => {
  await page.goto('/notes');
  await expect(
    page.getByRole('heading', { name: 'Notes', level: 1 }),
  ).toBeVisible();
  const rows = page.getByRole('row').filter({ has: page.getByRole('link') });
  await expect(rows).toHaveCount(20);
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Go to next page' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(20);
});

test('a filter changes the URL and the results', async ({ page }) => {
  await page.goto('/notes');
  await expect(
    page.getByRole('link', { name: /^E2E paging/ }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Filter' }).first().click();
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page
    .getByRole('dialog', { name: 'Filters' })
    .getByRole('button', { name: 'Number', exact: true })
    .click();
  await page.getByRole('option', { name: 'Title' }).click();
  await page.getByRole('combobox', { name: 'Title filter operator' }).click();
  await page.getByRole('option', { name: 'Contains' }).click();
  await page
    .getByRole('textbox', { name: 'Title filter value' })
    .fill('Northwind');
  await expect(page).toHaveURL(/title=Northwind/);
  const rows = page.getByRole('row').filter({ has: page.getByRole('link') });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Northwind');
});

test('creates, views, edits, deletes and restores a note', async ({ page }) => {
  const title = `E2E note ${Date.now()}`;

  await page.goto('/notes');
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Text').fill('First text.');
  await page.getByRole('button', { name: 'Create note' }).click();
  await expect(page.getByText('Note created')).toBeVisible();

  // The detail page.
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('First text.')).toBeVisible();

  // Edit.
  await page.getByRole('button', { name: 'Actions for this note' }).click();
  await page.getByRole('menuitem', { name: 'Edit note' }).click();
  await page.getByLabel('Text').fill('Second text.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Note saved')).toBeVisible();
  await expect(page.getByText('Second text.')).toBeVisible();

  // Delete from the list, then undo.
  await page.goto('/notes');
  await page.getByRole('searchbox', { name: 'Search' }).fill(title);
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Open actions/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByText('Note deleted')).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Note restored')).toBeVisible();
  await expect(row).toBeVisible();
});
