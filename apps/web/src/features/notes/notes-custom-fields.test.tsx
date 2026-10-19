import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  field,
  useCustomFieldsApi,
} from '@/features/custom-fields/test/custom-fields-api';
import { http } from 'msw/http';
import { renderApp } from '@/test/render-app';
import { problem, server } from '@/test/server';
import { NOTE_ID, sampleNote, useNotesApi } from './test/notes-api';

const NOTES = ['Note.read', 'Note.create', 'Note.update'];

describe('custom values in the note form', () => {
  const noteField = (over: Parameters<typeof field>[0] = {}) =>
    field({ subject: 'Note', ...over });
  const definitions = [
    noteField({ required: true }),
    noteField({
      id: '0199a3f2-0000-7000-8000-000000000a03',
      key: 'tags',
      label: 'Markets',
      type: 'multiSelect',
      validation: { max: 1 },
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    }),
    noteField({
      id: '0199a3f2-0000-7000-8000-000000000a04',
      key: 'budget',
      label: 'Budget',
      type: 'number',
      options: null,
      validation: { min: 10 },
    }),
    noteField({
      id: '0199a3f2-0000-7000-8000-000000000a05',
      key: 'urgent',
      label: 'Urgent',
      type: 'boolean',
      options: null,
    }),
    noteField({
      id: '0199a3f2-0000-7000-8000-000000000a06',
      key: 'due',
      label: 'Due date',
      type: 'date',
      options: null,
    }),
    noteField({
      id: '0199a3f2-0000-7000-8000-000000000a07',
      key: 'code',
      label: 'Code',
      type: 'text',
      options: null,
      default: 'X1',
      validation: { pattern: '[A-Z]+[0-9]' },
    }),
  ];

  function useNoteWithCustomFields(custom?: Record<string, unknown>) {
    const notes = useNotesApi({
      can: NOTES,
      notes: [sampleNote({ custom } as never)],
    });
    // The definitions: reading needs only Note.read.
    const api = useCustomFieldsApi({
      can: NOTES,
      fields: definitions,
      subject: 'Note',
    });
    return { ...notes, definitions: api };
  }

  it('renders a typed input for each active field, with the default filled in', async () => {
    useNoteWithCustomFields();
    await renderApp('/notes/new');
    expect(
      await screen.findByRole('combobox', { name: /Region/ }),
    ).toBeVisible();
    expect(screen.getByText('Markets')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: 'Budget' })).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Urgent' })).toBeVisible();
    expect(screen.getByLabelText('Due date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Code')).toHaveValue('X1');
  });

  it('checks the definitions before sending, then sends the values typed', async () => {
    const { calls } = useNoteWithCustomFields();
    const user = userEvent.setup();
    await renderApp('/notes/new');
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    await user.type(screen.getByRole('spinbutton', { name: 'Budget' }), '5');
    await user.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await user.clear(screen.getByLabelText('Code'));
    await user.type(screen.getByLabelText('Code'), 'zz');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    // Required region, the lowest budget, at most one market, the pattern.
    expect(await screen.findByText('This field is required.')).toBeVisible();
    expect(screen.getByText('At least 10.')).toBeVisible();
    expect(screen.getByText('Choose at most 1.')).toBeVisible();
    expect(
      screen.getByText('This value does not match the expected format.'),
    ).toBeVisible();
    expect(calls.created).toHaveLength(0);

    await user.click(screen.getByRole('combobox', { name: /Region/ }));
    await user.click(await screen.findByRole('option', { name: 'Americas' }));
    await user.clear(screen.getByRole('spinbutton', { name: 'Budget' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Budget' }), '12.5');
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await user.click(screen.getByRole('switch', { name: 'Urgent' }));
    await user.type(screen.getByLabelText('Due date'), '2026-03-04');
    await user.clear(screen.getByLabelText('Code'));
    await user.type(screen.getByLabelText('Code'), 'AB7');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]?.body).toEqual({
      title: 'Hello',
      body: '',
      custom: {
        region: 'us',
        tags: ['a'],
        budget: 12.5,
        urgent: true,
        due: '2026-03-04',
        code: 'AB7',
      },
    });
  });

  it('leaves a default the user did not change to the API', async () => {
    const { calls } = useNoteWithCustomFields();
    const user = userEvent.setup();
    await renderApp('/notes/new');
    await user.type(await screen.findByLabelText('Title'), 'Plain');
    await user.click(screen.getByRole('combobox', { name: /Region/ }));
    await user.click(await screen.findByRole('option', { name: 'Europe' }));
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]?.body).toEqual({
      title: 'Plain',
      body: '',
      custom: { region: 'eu' },
    });
  });

  it('shows the API errors on the field they name', async () => {
    const { calls } = useNoteWithCustomFields();
    server.use(
      http.post('/v1/notes', () =>
        problem(400, 'validation_failed', {
          errors: [
            { path: 'custom.budget', message: 'Budget is over the quota.' },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/notes/new');
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    await user.click(screen.getByRole('combobox', { name: /Region/ }));
    await user.click(await screen.findByRole('option', { name: 'Europe' }));
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    expect(await screen.findByText('Budget is over the quota.')).toBeVisible();
    expect(calls.created).toHaveLength(0);
  });

  it('edits the stored values and sends only the keys that changed, null for one emptied', async () => {
    const { calls } = useNoteWithCustomFields({
      region: 'us',
      budget: 20,
      code: 'Q9',
    });
    const user = userEvent.setup();
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const budget = await screen.findByRole('spinbutton', { name: 'Budget' });
    expect(budget).toHaveValue(20);
    expect(screen.getByLabelText('Code')).toHaveValue('Q9');
    await user.clear(budget);
    await user.type(budget, '30');
    await user.clear(screen.getByLabelText('Code'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]?.body).toEqual({
      custom: { budget: 30, code: null },
    });
  });

  it('shows the values on the detail page, a choice by its label', async () => {
    useNoteWithCustomFields({ region: 'us', budget: 20, tags: ['a', 'b'] });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(await screen.findByText('Americas')).toBeVisible();
    expect(screen.getByText('Alpha, Beta')).toBeVisible();
    expect(screen.getByText('Budget')).toBeVisible();
  });
});
