import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PersonPicker } from '@/components/person-picker';
import { PrincipalPicker } from '@/components/principal-picker';
import { peopleHandler } from '@/test/people';
import { principalsHandler } from '@/test/principals';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';

// The pickers show neither a hint nor an error: their caller does, beside
// them. `describedBy` (the ids from `useDescribedBy`) links those texts to
// the input, so a screen reader announces them after the picker's name.

const hint = <p id="hint">Type a part of a name.</p>;
const error = <p id="error">Choose someone.</p>;

describe.each([
  [
    'person',
    () => server.use(peopleHandler([])),
    (describedBy: string | undefined) => (
      <PersonPicker
        id="picker"
        label="Member"
        value=""
        onChange={() => undefined}
        invalid
        describedBy={describedBy}
      />
    ),
  ],
  [
    'principal',
    () => server.use(principalsHandler([])),
    (describedBy: string | undefined) => (
      <PrincipalPicker
        id="picker"
        label="Member"
        value=""
        onChange={() => undefined}
        invalid
        describedBy={describedBy}
      />
    ),
  ],
] as const)('the %s picker', (_name, answer, picker) => {
  it('is described by the hint and the error beside it', async () => {
    answer();
    await renderComponent(
      <>
        {picker('hint error')}
        {hint}
        {error}
      </>,
    );
    const input = screen.getByRole('combobox', { name: 'Member' });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(
      'Type a part of a name. Choose someone.',
    );
  });

  it('has no description when its caller gives none', async () => {
    answer();
    await renderComponent(
      <>
        {picker(undefined)}
        {hint}
      </>,
    );
    expect(
      screen.getByRole('combobox', { name: 'Member' }),
    ).toHaveAccessibleDescription('');
  });
});
