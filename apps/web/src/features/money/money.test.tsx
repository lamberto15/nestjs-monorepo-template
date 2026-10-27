import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { allFeatures } from '@/test/server';
import { useMoneyApi } from './test/money-api';

describe('gating', () => {
  it('has a menu entry only with the switch on', () => {
    const entries = (exchangeRates: boolean) =>
      visibleGroups(nav, { ...allFeatures, exchangeRates }, {}).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries(false)).not.toContain('/exchange-rates');
    expect(entries(true)).toContain('/exchange-rates');
  });

  it('has no such page with the switch off, and asks for no rates', async () => {
    const { calls } = useMoneyApi({ exchangeRates: false });
    await renderApp('/exchange-rates');
    expect(await screen.findByText(/not found/i)).toBeVisible();
    expect(screen.queryByText('Currency converter')).not.toBeInTheDocument();
    expect(calls.rates).toEqual([]);
  });
});

describe('the exchange rates page', () => {
  it('lists the day, its date and the rates, and filters by code or name', async () => {
    const { calls } = useMoneyApi();
    const user = userEvent.setup();
    await renderApp('/exchange-rates');
    expect(await screen.findByText('JPY')).toBeVisible();
    expect(screen.getByText(/Rates of 2026-10-20/)).toBeVisible();
    expect(screen.getByText('1.1652')).toBeVisible();
    expect(calls.rates[0]).toBeNull();
    await user.type(screen.getByLabelText('Search currency'), 'pound');
    await waitFor(() =>
      expect(screen.queryByText('JPY')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('GBP')).toBeVisible();
    await user.clear(screen.getByLabelText('Search currency'));
    await user.type(screen.getByLabelText('Search currency'), 'usd');
    await waitFor(() =>
      expect(
        screen.queryByRole('cell', { name: 'GBP' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('cell', { name: 'USD' })).toBeVisible();
    expect(screen.queryByText('GBP')).not.toBeInTheDocument();
  });

  it('asks for the picked day', async () => {
    const { calls } = useMoneyApi();
    await renderApp('/exchange-rates?date=2026-10-17');
    await screen.findByText('JPY');
    expect(calls.rates).toContain('2026-10-17');
  });

  it('explains an empty answer', async () => {
    useMoneyApi({ rates: null });
    await renderApp('/exchange-rates');
    expect(await screen.findByText('No exchange rates yet.')).toBeVisible();
  });

  it('with no rates says so once, asks for no conversion and shows no error', async () => {
    const { calls } = useMoneyApi({ rates: null });
    await renderApp('/exchange-rates');
    await screen.findByText('No exchange rates yet.');
    expect(
      screen.queryByText(/No exchange rates? (for \w+ )?on or before/),
    ).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Currency converter')).toBeNull();
    expect(calls.convert).toEqual([]);
  });
});

describe('the converter', () => {
  it('shows the result with the rate and its date', async () => {
    const { calls } = useMoneyApi();
    await renderApp('/exchange-rates');
    const section = await screen.findByRole('region', {
      name: 'Currency converter',
    });
    await waitFor(() => expect(calls.convert.length).toBeGreaterThan(0));
    expect(await within(section).findByText(/1,165\.20/)).toBeVisible();
    expect(
      within(section).getByText(/1 EUR = 116\.52 USD \(rates of 2026-10-20\)/),
    ).toBeVisible();
    expect(calls.convert[0]?.get('amount')).toBe('1');
    expect(calls.convert[0]?.get('currency')).toBe('EUR');
    expect(calls.convert[0]?.get('to')).toBe('USD');
  });

  it('refuses a bad amount without asking', async () => {
    const { calls } = useMoneyApi();
    const user = userEvent.setup();
    await renderApp('/exchange-rates');
    const amount = await screen.findByLabelText('Amount');
    await waitFor(() => expect(calls.convert.length).toBe(1));
    await user.clear(amount);
    await user.type(amount, '1,5x');
    expect(
      await screen.findByText('Enter an amount such as 12.34.'),
    ).toBeVisible();
    // Only valid amounts are sent: never the one with a comma or a letter.
    expect(
      calls.convert.some((query) => /[,x]/.test(query.get('amount') ?? '')),
    ).toBe(false);
  });

  it('describes the amount by why it is refused', async () => {
    useMoneyApi();
    const user = userEvent.setup();
    await renderApp('/exchange-rates');
    const amount = await screen.findByLabelText('Amount');
    expect(amount).toBeValid();
    expect(amount).toHaveAccessibleDescription('');
    await user.clear(amount);
    await user.type(amount, '1,5x');
    expect(amount).toBeInvalid();
    expect(amount).toHaveAccessibleDescription(
      'Enter an amount such as 12.34.',
    );
  });
});
