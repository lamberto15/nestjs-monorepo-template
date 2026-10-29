import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { findToast } from '@/test/toast';

const FORM_ID = '0199a3f2-0000-7000-8000-000000000f01';
const VERSION_ID = '0199a3f2-0000-7000-8000-000000000f02';
const at = '2026-10-28T10:00:00.000Z';

const definition = {
  format: 1,
  sections: [
    {
      key: 'contact',
      title: 'Contact',
      fields: [
        { key: 'full_name', type: 'text', label: 'Name', required: true },
        {
          key: 'topic',
          type: 'radio',
          label: 'Topic',
          options: [
            { value: 'billing', label: 'Billing' },
            { value: 'other', label: 'Something else' },
          ],
        },
        { key: 'seats', type: 'integer', label: 'Seats' },
      ],
    },
  ],
};

const form = (over: object = {}) => ({
  id: FORM_ID,
  slug: 'intake',
  name: 'Intake',
  description: null,
  status: 'active',
  revision: 3,
  publishedVersion: 1,
  hasDraftChanges: false,
  createdAt: at,
  updatedAt: at,
  ...over,
});

/** The forms API in memory; `enabled` is the tenant's forms.enabled. */
function useFormsApi(options: { enabled?: boolean; can?: string[] } = {}) {
  useSignedIn(options.can ?? ['Form.read', 'Form.edit', 'Form.submit']);
  const calls = {
    created: [] as unknown[],
    drafts: [] as { revision: number; definition: typeof definition }[],
    published: [] as unknown[],
    submitted: [] as { versionId: string; answers: Record<string, unknown> }[],
  };
  server.use(
    http.get('/v1/settings', () =>
      HttpResponse.json({
        items: [
          {
            key: 'forms.enabled',
            value: options.enabled ?? true,
            label: 'Forms',
            description: null,
          },
        ],
      }),
    ),
    http.get('/v1/forms', () =>
      HttpResponse.json({ items: [form()], nextCursor: null }),
    ),
    http.post('/v1/forms', async ({ request }) => {
      calls.created.push(await request.json());
      return HttpResponse.json(form({ publishedVersion: null, revision: 1 }), {
        status: 201,
      });
    }),
    http.get(`/v1/forms/${FORM_ID}`, () => HttpResponse.json(form())),
    http.get(`/v1/forms/${FORM_ID}/draft`, () =>
      HttpResponse.json({ formId: FORM_ID, revision: 3, definition }),
    ),
    http.put(`/v1/forms/${FORM_ID}/draft`, async ({ request }) => {
      const body = (await request.json()) as (typeof calls.drafts)[number];
      calls.drafts.push(body);
      return HttpResponse.json({
        formId: FORM_ID,
        revision: body.revision + 1,
        definition: body.definition,
      });
    }),
    http.post(`/v1/forms/${FORM_ID}/publish`, async ({ request }) => {
      calls.published.push(await request.json());
      return HttpResponse.json(
        {
          id: VERSION_ID,
          formId: FORM_ID,
          version: 2,
          definition,
          publishedAt: at,
        },
        { status: 201 },
      );
    }),
    http.get(`/v1/forms/${FORM_ID}/published`, () =>
      HttpResponse.json({
        formId: FORM_ID,
        slug: 'intake',
        name: 'Intake',
        description: null,
        versionId: VERSION_ID,
        version: 1,
        definition,
        publishedAt: at,
      }),
    ),
    http.post(`/v1/forms/${FORM_ID}/submissions`, async ({ request }) => {
      const body = (await request.json()) as (typeof calls.submitted)[number];
      calls.submitted.push(body);
      if (body.answers.full_name === 'Bad') {
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: 'validation_failed',
            errors: [{ path: 'answers.seats', message: 'At most 10.' }],
          },
          {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }
      return HttpResponse.json(
        {
          id: '0199a3f2-0000-7000-8000-000000000f03',
          formId: FORM_ID,
          versionId: VERSION_ID,
          version: 1,
          submittedBy: 'user:x',
          status: 'submitted',
          answers: body.answers,
          createdAt: at,
        },
        { status: 201 },
      );
    }),
  );
  return calls;
}

describe('forms', () => {
  it('says so while the tenant has forms off', async () => {
    useFormsApi({ enabled: false });
    await renderApp('/forms');
    expect(await screen.findByText('Forms are off')).toBeVisible();
  });

  it('lists the forms, and creates one with a slug from its name', async () => {
    const calls = useFormsApi();
    await renderApp('/forms');
    const table = await screen.findByRole('table', { name: 'Forms' });
    expect(within(table).getByText('Intake')).toBeVisible();
    expect(within(table).getByText('Version 1')).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New form' }));
    await user.type(await screen.findByLabelText('Name'), 'Site Inspection');
    expect(screen.getByLabelText('Slug')).toHaveValue('site-inspection');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({
      name: 'Site Inspection',
      slug: 'site-inspection',
    });
  });

  it('checks answers in the browser, shows the server’s at their field, then sends', async () => {
    const calls = useFormsApi();
    await renderApp(`/forms/${FORM_ID}/fill`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This answer is required.')).toBeVisible();
    expect(calls.submitted).toHaveLength(0);

    await user.type(screen.getByLabelText('Name *'), 'Bad');
    await user.type(screen.getByLabelText('Seats'), '11');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('At most 10.')).toBeVisible();

    await user.clear(screen.getByLabelText('Name *'));
    await user.type(screen.getByLabelText('Name *'), 'Ada');
    await user.click(screen.getByLabelText('Billing'));
    await user.clear(screen.getByLabelText('Seats'));
    await user.type(screen.getByLabelText('Seats'), '3');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText('Thank you: your answers were sent.'),
    ).toBeVisible();
    expect(calls.submitted.at(-1)).toEqual({
      versionId: VERSION_ID,
      answers: { full_name: 'Ada', topic: 'billing', seats: 3 },
    });
  });

  it('shows and requires fields by their conditions, and leaves hidden answers out', async () => {
    const calls = useFormsApi();
    const billing = { field: 'topic', op: 'eq', value: 'billing' };
    const fields = definition.sections[0]!.fields;
    server.use(
      http.get(`/v1/forms/${FORM_ID}/published`, () =>
        HttpResponse.json({
          formId: FORM_ID,
          slug: 'intake',
          name: 'Intake',
          description: null,
          versionId: VERSION_ID,
          version: 1,
          definition: {
            format: 2,
            sections: [
              {
                key: 'contact',
                fields: [
                  fields[0],
                  fields[1],
                  { ...fields[2], visibleWhen: billing, requiredWhen: billing },
                ],
              },
            ],
          },
          publishedAt: at,
        }),
      ),
    );
    await renderApp(`/forms/${FORM_ID}/fill`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name *'), 'Ada');
    expect(screen.queryByLabelText(/Seats/)).toBeNull();

    await user.click(screen.getByLabelText('Billing'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This answer is required.')).toBeVisible();
    await user.type(screen.getByLabelText('Seats *'), '2');

    // Hidden again: the typed seats are not sent.
    await user.click(screen.getByLabelText('Something else'));
    expect(screen.queryByLabelText(/Seats/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText('Thank you: your answers were sent.'),
    ).toBeVisible();
    expect(calls.submitted.at(-1)!.answers).toEqual({
      full_name: 'Ada',
      topic: 'other',
    });
  });

  it('fills a wizard page by page, skips a hidden page, and bounds a repeatable group', async () => {
    const calls = useFormsApi();
    const fields = definition.sections[0]!.fields;
    server.use(
      http.get(`/v1/forms/${FORM_ID}/published`, () =>
        HttpResponse.json({
          formId: FORM_ID,
          slug: 'intake',
          name: 'Intake',
          description: null,
          versionId: VERSION_ID,
          version: 1,
          definition: {
            format: 3,
            sections: [
              { key: 'contact', fields: [fields[0], fields[1]] },
              {
                key: 'more',
                startsPage: true,
                visibleWhen: { field: 'topic', op: 'eq', value: 'other' },
                fields: [
                  { key: 'details', type: 'textarea', label: 'Details' },
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
                      {
                        key: 'who',
                        type: 'text',
                        label: 'Who',
                        required: true,
                      },
                      { key: 'age', type: 'integer', label: 'Age' },
                    ],
                  },
                ],
              },
            ],
          },
          publishedAt: at,
        }),
      ),
    );
    await renderApp(`/forms/${FORM_ID}/fill`);
    const user = userEvent.setup();
    // The "more" page is hidden (topic isn't other): two steps.
    expect(await screen.findByText('Step 1 of 2')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

    // Next checks this page first, and puts the focus on its error.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('This answer is required.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Name *')).toHaveFocus());
    await user.type(screen.getByLabelText('Name *'), 'Ada');
    await user.keyboard('{Enter}');
    const step = await screen.findByText('Step 2 of 2');
    await waitFor(() => expect(step).toHaveFocus());

    // One item to start with (minItems), at most two.
    const remove = screen.getByRole('button', { name: 'Remove Person 1' });
    expect(remove).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This answer is required.')).toBeVisible();
    await user.type(screen.getByLabelText('Who *'), 'Bo');
    await user.click(screen.getByRole('button', { name: 'Add Person' }));
    expect(screen.getByRole('button', { name: 'Add Person' })).toBeDisabled();
    const second = screen.getByRole('group', { name: 'Person 2' });
    await user.type(within(second).getByLabelText('Who *'), 'Cy');
    await user.type(within(second).getByLabelText('Age'), '4');

    // Back keeps the answers.
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByLabelText('Name *')).toHaveValue('Ada');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText('Thank you: your answers were sent.'),
    ).toBeVisible();
    expect(calls.submitted.at(-1)!.answers).toEqual({
      full_name: 'Ada',
      people: [{ who: 'Bo' }, { who: 'Cy', age: 4 }],
    });
  });

  it('builds pages and a repeatable group', async () => {
    const calls = useFormsApi();
    await renderApp(`/forms/${FORM_ID}`);
    const user = userEvent.setup();
    const preview = await screen.findByRole('region', { name: 'Preview' });
    await user.click(
      screen.getByRole('checkbox', { name: 'Starts a new page' }),
    );
    await user.click(
      screen.getByRole('combobox', { name: "New field's type" }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Repeatable group' }),
    );
    await user.click(screen.getByRole('button', { name: 'Add a field' }));
    await user.type(screen.getByLabelText('Most items'), '3');
    expect(
      within(preview).getByRole('button', { name: 'Add Repeatable group' }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await findToast('Draft saved.');
    const saved = calls.drafts[0]!.definition;
    expect(saved).toMatchObject({ format: 3 });
    expect(saved.sections[0]).toMatchObject({ startsPage: true });
    expect(saved.sections[0]!.fields.at(-1)).toEqual({
      key: 'field_4',
      type: 'group',
      label: 'Repeatable group',
      validation: { maxItems: 3 },
      fields: [{ key: 'item_1', type: 'text', label: 'Short text' }],
    });
  });

  it('edits a condition visually, and the preview follows it', async () => {
    const calls = useFormsApi();
    await renderApp(`/forms/${FORM_ID}`);
    const user = userEvent.setup();
    const preview = await screen.findByRole('region', { name: 'Preview' });
    expect(within(preview).getByLabelText('Seats')).toBeVisible();

    // The first field has nothing before it to read.
    const rules = screen.getAllByRole('group', { name: 'Show only when' });
    expect(
      within(rules[0]!).getByText(/reads the fields before this one/),
    ).toBeVisible();
    // Seats: shown only when the topic (the field before) is Billing.
    await user.click(
      within(rules[2]!).getByRole('button', { name: 'Add a condition' }),
    );
    expect(within(preview).queryByLabelText('Seats')).toBeNull();
    await user.click(within(preview).getByLabelText('Billing'));
    expect(within(preview).getByLabelText('Seats')).toBeVisible();

    // Then "not equal to": hidden for Billing.
    await user.click(within(rules[2]!).getByRole('combobox', { name: 'Is' }));
    await user.click(
      await screen.findByRole('option', { name: 'not equal to' }),
    );
    expect(within(preview).queryByLabelText('Seats')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await findToast('Draft saved.');
    expect(calls.drafts[0]!.definition).toMatchObject({ format: 3 });
    expect(calls.drafts[0]!.definition.sections[0]!.fields[2]).toMatchObject({
      key: 'seats',
      visibleWhen: { field: 'topic', op: 'ne', value: 'billing' },
    });
  });

  it('builds the draft with a live preview, saves it under its revision, then publishes', async () => {
    const calls = useFormsApi();
    await renderApp(`/forms/${FORM_ID}`);
    const user = userEvent.setup();
    const preview = await screen.findByRole('region', { name: 'Preview' });
    expect(within(preview).getByLabelText('Name *')).toBeVisible();

    // Publishing waits for the changes to be saved.
    await user.click(screen.getByRole('button', { name: 'Add a field' }));
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(within(preview).getByLabelText('Short text')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await findToast('Draft saved.');
    expect(calls.drafts[0]!.revision).toBe(3);
    expect(
      calls.drafts[0]!.definition.sections[0]!.fields.at(-1),
    ).toMatchObject({
      key: 'field_4',
      type: 'text',
      label: 'Short text',
    });

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await findToast('Version 2 published.');
    expect(calls.published).toEqual([{ revision: 4 }]);
  });
});
