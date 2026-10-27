import { ApiError } from '@nestjs-monorepo-template/api-client';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';

// A route whose page throws while rendering (what the test sets).
const page = vi.hoisted(() => ({ throws: new Error('boom') as unknown }));
vi.mock('@/features/money/exchange-rates-page', () => ({
  ExchangeRatesPage: () => {
    throw page.throws;
  },
}));

// The build this tab runs (empty under Vitest otherwise).
vi.mock('@/lib/build-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/build-version')>()),
  loadedSha: 'c0ffee'.repeat(6) + 'beef',
}));

describe('the route error boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the error page in the route, with a report id, and keeps the nav usable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    useSignedIn([]);
    await renderApp('/exchange-rates');

    expect(await screen.findByText('Something went wrong')).toBeVisible();
    expect(
      screen.getByText(/^Report ID: [0-9a-f]{8} · Build: c0ffeec0ffee$/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(
      logged.mock.calls.some(([m]) => String(m).includes('route error')),
    ).toBe(true);

    // The layout around the failed route still works: navigate away.
    await userEvent.click(
      await screen.findByRole('link', { name: 'Dashboard' }),
    );
    expect(
      await screen.findByText('Dashboard', { selector: 'h1' }),
    ).toBeVisible();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it("gives the API's request id when the route's request failed", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    page.throws = new ApiError({
      status: 500,
      code: 'internal',
      detail: 'Something broke.',
      requestId: 'req-12345678',
    });
    useSignedIn([]);
    await renderApp('/exchange-rates');

    expect(await screen.findByText(/Request ID: req-12345678/)).toBeVisible();
    page.throws = new Error('boom');
  });
});
