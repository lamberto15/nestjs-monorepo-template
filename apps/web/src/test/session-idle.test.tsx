import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server, signedInUser } from '@/test/server';

const withSession = (idleMinutes: number) => ({
  ...signedInUser,
  session: {
    idleMinutes,
    lastActiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
  },
});

describe('the idle timeout warning', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      shouldAdvanceTime: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns two minutes before the idle timeout, and "Stay signed in" asks the API', async () => {
    let asked = 0;
    server.use(
      http.get('/v1/auth/me', () => {
        asked += 1;
        return HttpResponse.json(withSession(5));
      }),
    );
    await renderApp('/');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const before = asked;

    // Two minutes short of five: 3 minutes without input.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 2000);
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Your session is about to end');
    expect(dialog).toHaveTextContent(/signed out in 1:5\d/);

    await userEvent
      .setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
      .click(screen.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(asked).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
  });

  it('says nothing for a session without a lifetime (a token, an impersonation)', async () => {
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({ ...signedInUser, session: null }),
      ),
    );
    await renderApp('/');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
