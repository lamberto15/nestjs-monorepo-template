import { expect, test, asRole } from './fixtures';

test.use(asRole('administrator'));

/** Forms turned on for the tenant, through the API. */
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext(asRole('administrator'));
  const on = await context.request.put('/v1/settings/forms.enabled', {
    data: { value: true },
  });
  expect(on.ok(), await on.text()).toBe(true);
  await context.close();
});

test('a condition edited in the builder shows and requires a field when filling in', async ({
  page,
}) => {
  const created = await page.request.post('/v1/forms', {
    data: {
      slug: `e2e-rules-${Date.now()}`,
      name: 'E2E rules',
      definition: {
        sections: [
          {
            key: 'main',
            title: 'Request',
            fields: [
              { key: 'full_name', type: 'text', label: 'Name' },
              {
                key: 'topic',
                type: 'radio',
                label: 'Topic',
                options: [
                  { value: 'billing', label: 'Billing' },
                  { value: 'other', label: 'Something else' },
                ],
              },
              { key: 'invoice', type: 'text', label: 'Invoice number' },
            ],
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };

  await page.goto(`/forms/${id}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByLabel('Invoice number')).toBeVisible();
  // Invoice number: shown when the topic (the field before it) is Billing...
  const shown = page.getByRole('group', { name: 'Show only when' }).nth(2);
  await shown.getByRole('button', { name: 'Add a condition' }).click();
  await expect(preview.getByLabel('Invoice number')).toBeHidden();
  await preview.getByLabel('Billing').check();
  await expect(preview.getByLabel('Invoice number')).toBeVisible();
  // ...and then required.
  const required = page.getByRole('group', { name: 'Required when' }).nth(2);
  await required.getByRole('button', { name: 'Add a condition' }).click();
  await expect(preview.getByLabel('Invoice number *')).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Version 1 published.')).toBeVisible();

  await page.goto(`/forms/${id}/fill`);
  await page.getByLabel('Name').fill('Ada');
  await expect(page.getByLabel(/Invoice number/)).toBeHidden();
  await page.getByLabel('Billing').check();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('This answer is required.')).toBeVisible();
  await page.getByLabel('Invoice number *').fill('A-17');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText('Thank you: your answers were sent.'),
  ).toBeVisible();
});

test('a wizard is filled in page by page with the keyboard, a repeatable group within bounds', async ({
  page,
}) => {
  const created = await page.request.post('/v1/forms', {
    data: {
      slug: `e2e-steps-${Date.now()}`,
      name: 'E2E steps',
      definition: {
        sections: [
          {
            key: 'contact',
            fields: [
              { key: 'full_name', type: 'text', label: 'Name', required: true },
            ],
          },
          {
            key: 'team',
            startsPage: true,
            fields: [
              {
                key: 'people',
                type: 'group',
                label: 'Person',
                validation: { minItems: 1, maxItems: 2 },
                fields: [
                  { key: 'who', type: 'text', label: 'Who', required: true },
                ],
              },
            ],
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const form = (await created.json()) as { id: string; revision: number };
  const published = await page.request.post(`/v1/forms/${form.id}/publish`, {
    data: { revision: form.revision },
  });
  expect(published.ok(), await published.text()).toBe(true);

  await page.goto(`/forms/${form.id}/fill`);
  await expect(page.getByText('Step 1 of 2')).toBeVisible();
  // Enter on an empty page: its error, and the focus on it.
  await page.getByLabel('Name *').press('Enter');
  await expect(page.getByText('This answer is required.')).toBeVisible();
  await expect(page.getByLabel('Name *')).toBeFocused();
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Step 2 of 2')).toBeFocused();

  await page.getByLabel('Who *').fill('Bo');
  await page.getByRole('button', { name: 'Add Person' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Add Person' })).toBeDisabled();
  await page
    .getByRole('group', { name: 'Person 2' })
    .getByLabel('Who *')
    .fill('Cy');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByLabel('Name *')).toHaveValue('Ada');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText('Thank you: your answers were sent.'),
  ).toBeVisible();
});

test('a field takes its choices from an option source, and its value is checked on sending', async ({
  page,
}) => {
  const name = `E2E unit ${Date.now()}`;
  const unit = await page.request.post('/v1/access/organizational-units', {
    data: { type: 'team', name },
  });
  expect(unit.ok(), await unit.text()).toBe(true);
  const created = await page.request.post('/v1/forms', {
    data: {
      slug: `e2e-sources-${Date.now()}`,
      name: 'E2E sources',
      definition: {
        sections: [
          {
            key: 'main',
            fields: [
              {
                key: 'unit',
                type: 'radio',
                label: 'Unit',
                required: true,
                optionsSource: { provider: 'organizational-units' },
              },
            ],
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const form = (await created.json()) as { id: string; revision: number };
  const published = await page.request.post(`/v1/forms/${form.id}/publish`, {
    data: { revision: form.revision },
  });
  expect(published.ok(), await published.text()).toBe(true);

  await page.goto(`/forms/${form.id}/fill`);
  await page.getByLabel('Search Unit').fill(name);
  await page.getByLabel(name).check();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText('Thank you: your answers were sent.'),
  ).toBeVisible();
});

test('a public link opens the form to someone signed out, and stops once revoked', async ({
  page,
  browser,
}) => {
  const created = await page.request.post('/v1/forms', {
    data: {
      slug: `e2e-public-${Date.now()}`,
      name: 'E2E public',
      definition: {
        sections: [
          {
            key: 'main',
            fields: [
              { key: 'full_name', type: 'text', label: 'Name', required: true },
            ],
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const form = (await created.json()) as { id: string; revision: number };
  const published = await page.request.post(`/v1/forms/${form.id}/publish`, {
    data: { revision: form.revision },
  });
  expect(published.ok(), await published.text()).toBe(true);

  // The editor makes the link in the builder.
  await page.goto(`/forms/${form.id}`);
  const links = page.getByRole('region', { name: 'Public links' });
  await links.getByRole('button', { name: 'Make a link' }).click();
  const url = await links.getByLabel('The new link').inputValue();
  const token = url.slice(url.indexOf('#') + 1);

  // A context of its own: no session, no cookie (it doesn't take the project's baseURL).
  const origin = new URL(page.url()).origin;
  const stranger = await browser.newContext();
  const outside = await stranger.newPage();
  await outside.goto(`${origin}/public-form#${token}`);
  await outside.getByLabel('Name *').fill('Eve');
  await outside.getByRole('button', { name: 'Send' }).click();
  await expect(
    outside.getByText('Thank you: your answers were sent.'),
  ).toBeVisible();

  await links.getByRole('button', { name: 'Revoke' }).click();
  await expect(links.getByText('Closed')).toBeVisible();
  await outside.goto(`${origin}/`);
  await outside.goto(`${origin}/public-form#${token}`);
  await expect(outside.getByText(/This link doesn't work/)).toBeVisible();
  await stranger.close();
});
