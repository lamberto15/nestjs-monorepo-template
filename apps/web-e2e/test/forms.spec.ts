import { expect, test, asRole } from './fixtures';

test.use(asRole('administrator'));

/** A form of three fields, made through the API with forms turned on. */
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
