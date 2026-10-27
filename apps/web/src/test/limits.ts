import { within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/** Replaces a field's value with one character more than `max` allows. */
export async function fillOver(
  user: UserEvent,
  field: HTMLElement,
  max: number,
) {
  await user.clear(field);
  await user.paste('x'.repeat(max + 1));
}

/**
 * One character over `max` in the field labelled `label` (within `scope`),
 * then `submit`: the form says the limit in words. The caller checks that
 * nothing was sent.
 */
export async function expectOverLimitRefused(
  user: UserEvent,
  options: { scope?: HTMLElement; label: string; max: number; submit: string },
) {
  const inside = within(options.scope ?? document.body);
  await fillOver(user, inside.getByLabelText(options.label), options.max);
  await user.click(inside.getByRole('button', { name: options.submit }));
  expect(
    await inside.findByText(`At most ${options.max} characters.`),
  ).toBeVisible();
}
