import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

// What a user does with the bulk actions of a list (features/bulk): tick
// rows, answer the question, watch the run. The list is rendered by the test.

export const bar = () =>
  screen.findByRole('toolbar', { name: 'Selection actions' });

/** The action bar is gone: the run ended or the selection was cleared. */
export const expectNoBar = () =>
  waitFor(() =>
    expect(
      screen.queryByRole('toolbar', { name: 'Selection actions' }),
    ).not.toBeInTheDocument(),
  );

/** Ticks the rows with these titles, one by one. */
export async function choose(...titles: string[]) {
  const user = userEvent.setup();
  for (const title of titles) {
    const row = (await screen.findByText(title)).closest('tr')!;
    await user.click(within(row).getByRole('checkbox', { name: 'Select row' }));
  }
  return user;
}

/** Ticks "Select all" of the page once `firstTitle` is in it; the bar counts `count`. */
export async function selectPage(firstTitle: string, count: number) {
  const user = userEvent.setup();
  await screen.findByText(firstTitle);
  await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
  const toolbar = await bar();
  expect(within(toolbar).getByText(`${count} selected`)).toBeVisible();
  return { user, toolbar };
}

/** Delete in the action bar, and the question it asks (`Delete 2 records?`). */
export async function askDelete(user: UserEvent, question: string) {
  await user.click(within(await bar()).getByRole('button', { name: 'Delete' }));
  return screen.findByRole('alertdialog', { name: question });
}

/** Delete in the action bar, answered with Delete. */
export async function confirmDelete(user: UserEvent, question: string) {
  const confirm = await askDelete(user, question);
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
}

/** "Records not done" lists one record, with the reason the API gave. */
export async function expectOneNotDone(reason: RegExp) {
  const problems = await screen.findByRole('list', {
    name: 'Records not done',
  });
  expect(within(problems).getAllByRole('listitem')).toHaveLength(1);
  expect(within(problems).getByText(reason)).toBeVisible();
}

/** The run's dialog (`Deleting`, `Restoring`, ...). */
export const runDialog = (name: string) =>
  screen.findByRole('dialog', { name });

/** What the run's dialog says, once it does (polls are a second apart: `timeout`). */
export async function expectRunText(
  run: HTMLElement,
  text: string,
  timeout?: number,
) {
  expect(await within(run).findByText(text, {}, { timeout })).toBeVisible();
}

/** The run's dialog, once it says all of the two records are done. */
export async function expectRunDone(name: string) {
  await expectRunText(await runDialog(name), '2 done, 0 failed, 0 skipped.');
}
