import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

// Each field helper with a hint, and with the hint and its error: the
// control's accessible description (aria-describedby) is what a screen
// reader announces after its name.

const required = z.string().min(1, 'Required');
const options = [{ value: 'en', label: 'English' }];

function Form(props: { field: 'text' | 'textarea' | 'code' | 'select' }) {
  const form = useAppForm({
    defaultValues: { value: '' },
    onSubmit: () => undefined,
  });
  const common = { name: 'value' as const, validators: { onChange: required } };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {props.field === 'text' && (
        <form.AppField
          {...common}
          children={(f) => <f.TextField label="Name" description="Hint" />}
        />
      )}
      {props.field === 'textarea' && (
        <form.AppField
          {...common}
          children={(f) => <f.TextAreaField label="Name" description="Hint" />}
        />
      )}
      {props.field === 'code' && (
        <form.AppField
          {...common}
          children={(f) => <f.CodeField label="Name" description="Hint" />}
        />
      )}
      {props.field === 'select' && (
        <form.AppField
          {...common}
          children={(f) => (
            <f.SelectField label="Name" description="Hint" options={options} />
          )}
        />
      )}
      <button type="submit">Send</button>
    </form>
  );
}

const cases = [
  ['TextField', 'text', () => screen.getByRole('textbox', { name: 'Name' })],
  [
    'TextAreaField',
    'textarea',
    () => screen.getByRole('textbox', { name: 'Name' }),
  ],
  ['CodeField', 'code', () => screen.getByLabelText('Name')],
  [
    'SelectField',
    'select',
    () => screen.getByRole('combobox', { name: 'Name' }),
  ],
] as const;

describe.each(cases)('%s', (_name, field, control) => {
  it('is described by its hint', () => {
    render(<Form field={field} />);
    expect(control()).toHaveAccessibleDescription('Hint');
  });

  it('is described by its hint and its error', async () => {
    render(<Form field={field} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Required');
    expect(control()).toHaveAccessibleDescription('Hint Required');
  });
});

describe('a field without a hint', () => {
  it('is described by its error alone, and by nothing before it', async () => {
    function Bare() {
      const form = useAppForm({
        defaultValues: { value: '' },
        onSubmit: () => undefined,
      });
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.AppField
            name="value"
            validators={{ onChange: required }}
            children={(f) => <f.TextField label="Name" />}
          />
          <button type="submit">Send</button>
        </form>
      );
    }
    render(<Bare />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).not.toHaveAttribute('aria-describedby');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    expect(input).toHaveAccessibleDescription('Required');
  });
});
