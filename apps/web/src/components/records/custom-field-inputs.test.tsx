import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CustomField } from '@/lib/custom-fields';
import { renderComponent } from '@/test/render-component';
import { CustomFieldInputs } from './custom-field-inputs';

// A custom field's hint and error are its control's accessible description
// (aria-describedby), as for lib/form.tsx's fields: what a screen reader
// announces after the field's name.

const field = (
  type: CustomField['type'],
  extra: Partial<CustomField> = {},
): CustomField => ({
  id: '0199a3f2-0000-7000-8000-0000000000f1',
  subject: 'TestItem',
  key: type,
  label: 'Budget',
  description: 'In euros.',
  type,
  options: null,
  required: false,
  default: null,
  validation: null,
  position: 0,
  filterable: false,
  sortable: false,
  active: true,
  valueCount: 0,
  deletedValueCount: 0,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...extra,
});

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

const cases = [
  [
    'text',
    field('text'),
    () => screen.getByRole('textbox', { name: 'Budget' }),
  ],
  [
    'longText',
    field('longText'),
    () => screen.getByRole('textbox', { name: 'Budget' }),
  ],
  [
    'number',
    field('number'),
    () => screen.getByRole('spinbutton', { name: 'Budget' }),
  ],
  [
    'boolean',
    field('boolean'),
    () => screen.getByRole('switch', { name: 'Budget' }),
  ],
  [
    'select',
    field('select', { options }),
    () => screen.getByRole('combobox', { name: 'Budget' }),
  ],
  [
    'multiSelect',
    field('multiSelect', { options }),
    () => screen.getByRole('group', { name: 'Budget' }),
  ],
] as const;

describe.each(cases)('a %s custom field', (_type, definition, control) => {
  const render = (errors?: Record<string, string>) =>
    renderComponent(
      <CustomFieldInputs
        fields={[definition]}
        value={{}}
        onChange={() => undefined}
        errors={errors}
      />,
    );

  it('is described by its hint', async () => {
    await render();
    expect(control()).toHaveAccessibleDescription('In euros.');
  });

  it('is described by its hint and its error', async () => {
    await render({ [definition.key]: 'Over the quota.' });
    expect(control()).toHaveAccessibleDescription('In euros. Over the quota.');
  });
});
