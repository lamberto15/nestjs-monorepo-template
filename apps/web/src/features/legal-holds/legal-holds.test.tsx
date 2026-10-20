import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { problem, server } from '@/test/server';
import { findToast } from '@/test/toast';
import {
  HOLDS,
  NOTE_HOLD,
  RECORD_ID,
  hold,
  useLegalHoldsApi,
} from './test/legal-holds-api';

const ADMIN = ['Access.manageLegalHolds'];

async function rowOf(text: string) {
  const table = await screen.findByRole('table');
  return within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByText(text))!;
}

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/legal-holds');
    expect(entries({ 'Access.manageLegalHolds': true })).toContain(
      '/legal-holds',
    );
  });

  it('sends a user without the permission away, with no request', async () => {
    const { calls } = useLegalHoldsApi({ can: ['Note.read'] });
    const { router } = await renderApp('/legal-holds');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.reads).toEqual([]);
  });
});

describe('the list', () => {
  it('shows active and released holds, and filters them', async () => {
    const { calls } = useLegalHoldsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    const active = await rowOf('Dispute with Acme, case 2026-114');
    expect(
      within(active).getByText('Every record of the subject'),
    ).toBeVisible();
    expect(within(active).getByText('Active')).toBeVisible();
    const released = await rowOf('Audit of a leaver');
    expect(within(released).getByText(RECORD_ID)).toBeVisible();
    expect(within(released).getByText('Released')).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Active' }));
    await waitFor(() => expect(calls.reads.at(-1)?.get('active')).toBe('true'));
    await waitFor(() =>
      expect(screen.queryByText('Audit of a leaver')).toBeNull(),
    );

    await user.type(screen.getByLabelText('Subject'), 'Invoice');
    expect(await screen.findByText('No legal hold matches.')).toBeVisible();
    expect(calls.reads.at(-1)?.get('subject')).toBe('Invoice');
  });

  it('loads the next page on request', async () => {
    const many = [
      hold({ reason: 'First' }),
      hold({ id: '0199a3f2-0000-7000-8000-000000000611', reason: 'Second' }),
    ];
    const { calls } = useLegalHoldsApi({
      can: ADMIN,
      holds: many,
      pageSize: 1,
    });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    expect(await screen.findByText('First')).toBeVisible();
    expect(screen.queryByText('Second')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Second')).toBeVisible();
    expect(calls.reads.at(-1)?.get('cursor')).toBe('1');
  });

  it('says so when there are none', async () => {
    useLegalHoldsApi({ can: ADMIN, holds: [] });
    await renderApp('/legal-holds');
    expect(await screen.findByText('No legal holds yet.')).toBeVisible();
  });
});

describe('placing a hold', () => {
  it('sends the subject, the record and the reason', async () => {
    const { calls } = useLegalHoldsApi({ can: ADMIN, holds: [] });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    await user.click(
      await screen.findByRole('button', { name: 'Place a legal hold' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Subject'), 'Note');
    await user.type(
      within(dialog).getByLabelText('Record ID (optional)'),
      RECORD_ID,
    );
    await user.type(within(dialog).getByLabelText('Reason'), 'Case 7');
    await user.click(
      within(dialog).getByRole('button', { name: 'Place hold' }),
    );
    await findToast('Legal hold placed.');
    expect(calls.placed).toEqual([
      { subject: 'Note', recordId: RECORD_ID, reason: 'Case 7' },
    ]);
    expect(await screen.findByText('Case 7')).toBeVisible();
  });

  it('holds every record when none is named, and checks the fields', async () => {
    const { calls } = useLegalHoldsApi({ can: ADMIN, holds: [] });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    await user.click(
      await screen.findByRole('button', { name: 'Place a legal hold' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Subject'), 'note');
    await user.type(within(dialog).getByLabelText('Record ID (optional)'), 'x');
    await user.click(
      within(dialog).getByRole('button', { name: 'Place hold' }),
    );
    expect(
      await within(dialog).findByText('A subject is a name such as Note.'),
    ).toBeVisible();
    expect(within(dialog).getByText('A record ID is a UUID.')).toBeVisible();
    expect(within(dialog).getByText('Enter a reason.')).toBeVisible();
    expect(calls.placed).toEqual([]);

    await user.clear(within(dialog).getByLabelText('Subject'));
    await user.type(within(dialog).getByLabelText('Subject'), 'Note');
    await user.clear(within(dialog).getByLabelText('Record ID (optional)'));
    await user.type(within(dialog).getByLabelText('Reason'), 'Everything');
    await user.click(
      within(dialog).getByRole('button', { name: 'Place hold' }),
    );
    await findToast('Legal hold placed.');
    expect(calls.placed).toEqual([{ subject: 'Note', reason: 'Everything' }]);
  });
});

describe('one hold', () => {
  it('shows an active hold and releases it with a note', async () => {
    const { calls } = useLegalHoldsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    await rowOf('Dispute with Acme, case 2026-114');
    await user.click(
      (
        await screen.findAllByRole('button', { name: 'Open the hold on Note' })
      )[0]!,
    );
    const detail = await screen.findByRole('dialog');
    expect(
      await within(detail).findByText('user:ada', { exact: false }),
    ).toBeVisible();
    await user.click(within(detail).getByRole('button', { name: 'Release' }));
    const release = (await screen.findAllByRole('dialog')).at(-1)!;
    await user.type(
      within(release).getByLabelText('Note (optional)'),
      'Settled',
    );
    await user.click(
      within(release).getByRole('button', { name: 'Release hold' }),
    );
    await findToast('Legal hold released.');
    expect(calls.released).toEqual([
      { id: NOTE_HOLD, body: { note: 'Settled' } },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = await rowOf('Dispute with Acme, case 2026-114');
    await waitFor(() =>
      expect(within(row).getByText('Released')).toBeVisible(),
    );
  });

  it('shows a released hold with its note and no release button', async () => {
    useLegalHoldsApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    const row = await rowOf('Audit of a leaver');
    await user.click(
      within(row).getByRole('button', { name: /Open the hold/ }),
    );
    const detail = await screen.findByRole('dialog');
    expect(await within(detail).findByText('Audit closed')).toBeVisible();
    expect(
      within(detail).queryByRole('button', { name: 'Release' }),
    ).toBeNull();
  });

  it('says so when the hold was released meanwhile (409)', async () => {
    useLegalHoldsApi({ can: ADMIN, holds: [HOLDS[0]!] });
    const user = userEvent.setup();
    await renderApp('/legal-holds');
    await user.click(
      await screen.findByRole('button', { name: 'Open the hold on Note' }),
    );
    const detail = await screen.findByRole('dialog');
    await within(detail).findByText('Active');
    // Released in another tab: the page's copy is stale, the API says 409.
    server.use(
      http.post('/v1/legal-holds/:id/release', () =>
        problem(409, 'legal_hold_released'),
      ),
    );
    await user.click(within(detail).getByRole('button', { name: 'Release' }));
    const release = (await screen.findAllByRole('dialog')).at(-1)!;
    await user.click(
      within(release).getByRole('button', { name: 'Release hold' }),
    );
    expect(
      await within(release).findByText('legal_hold_released (test)'),
    ).toBeVisible();
  });
});
