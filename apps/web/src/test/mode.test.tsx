import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODE_POLL, type Mode } from '@/lib/mode';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { findToast } from '@/test/toast';

// The deployment's mode (docs/settings.md, "Maintenance and read-only mode")
// as the signed-in app shows it: `GET /v1/features` carries `mode`; read-only
// is a banner and writes turned off, maintenance one full-page notice.

/**
 * Signs in and serves the switches with `state.mode`, which a test may change
 * (the operators' write, or time passing). Counts what the app asked for.
 */
function useDeployment(initial: Mode, can: string[] = []) {
  const state = { mode: initial };
  const asked = { features: 0, approvals: 0, notifications: 0 };
  useSignedIn(can);
  server.use(
    http.get('/v1/features', () => {
      asked.features += 1;
      return HttpResponse.json({
        ...allFeatures,
        realtime: false,
        mode: state.mode,
      });
    }),
    http.get('/v1/approvals', () => {
      asked.approvals += 1;
      return HttpResponse.json({ items: [], nextCursor: null, total: 0 });
    }),
    http.get('/v1/notifications', () => {
      asked.notifications += 1;
      return HttpResponse.json({ items: [], nextCursor: null });
    }),
  );
  return { state, asked };
}

const dashboard = () => screen.findByText('Dashboard', { selector: 'h1' });
const maintenanceTitle = () =>
  screen.findByRole('heading', { name: 'Down for maintenance' });

describe('a normal deployment', () => {
  it('shows no banner and no notice', async () => {
    useDeployment('normal');
    await renderApp('/');
    expect(await dashboard()).toBeVisible();
    expect(screen.queryByText(/read-only right now/)).toBeNull();
    expect(screen.queryByText('Down for maintenance')).toBeNull();
  });
});

describe('a read-only deployment', () => {
  it('says so on every page, and the page works for reading', async () => {
    useDeployment('read-only');
    await renderApp('/');
    expect(await dashboard()).toBeVisible();
    expect(await screen.findByRole('status')).toHaveTextContent(
      "The service is read-only right now. You can look around, but changes can't be saved until it's back.",
    );
  });

  it('turns the forms off: the submit button is disabled', async () => {
    useDeployment('read-only');
    await renderApp('/account/profile');
    await screen.findByText(/read-only right now/);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('learns of it from a refused write, and says so at once', async () => {
    const deployment = useDeployment('normal');
    server.use(
      http.patch('/v1/auth/me', () => {
        // The operators switched the mode on; the app has not asked yet.
        deployment.state.mode = 'read-only';
        return problem(503, 'read_only');
      }),
    );
    await renderApp('/account/profile');
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    expect(screen.queryByText(/read-only right now/)).toBeNull();

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' B');
    await user.click(save);

    expect(await screen.findByText(/read-only right now/)).toBeVisible();
    expect(screen.getByText('read_only (test)')).toBeVisible();
    await waitFor(() => expect(save).toBeDisabled());
  });
});

describe('the mode, kept fresh', () => {
  afterEach(() => vi.useRealTimers());

  /** The user does something on the page (what the idle timeout counts). */
  const input = () =>
    act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
    });

  it('is not asked on a timer while normal: an unattended tab must time out', async () => {
    // Any request is activity to the API (docs/auth.md, "Session lifetime"):
    // a poll would keep an idle session signed in for ever.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { asked } = useDeployment('normal');
    await renderApp('/');
    expect(await dashboard()).toBeVisible();
    const before = asked.features;

    await act(async () => {
      vi.advanceTimersByTime(60 * MODE_POLL.normal);
    });
    expect(asked.features).toBe(before);
  });

  it('is asked again when the user does something, at most once a minute', async () => {
    // Only the clock is faked: the answer's age decides whether to ask.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { state, asked } = useDeployment('normal');
    await renderApp('/');
    expect(await dashboard()).toBeVisible();
    const before = asked.features;

    // Just asked: the input costs no request.
    state.mode = 'read-only';
    await input();
    expect(asked.features).toBe(before);
    expect(screen.queryByText(/read-only right now/)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(MODE_POLL.normal);
    });
    await input();
    expect(await screen.findByText(/read-only right now/)).toBeVisible();
    expect(asked.features).toBe(before + 1);
  });

  it('is asked every 15 seconds while it is not normal, until it is', async () => {
    // Only the interval is faked: waiting for the screen uses timeouts.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { state, asked } = useDeployment('read-only');
    await renderApp('/');
    expect(await screen.findByText(/read-only right now/)).toBeVisible();
    const before = asked.features;

    state.mode = 'normal';
    await act(async () => {
      vi.advanceTimersByTime(MODE_POLL.restricted);
    });
    await waitFor(() =>
      expect(screen.queryByText(/read-only right now/)).toBeNull(),
    );
    expect(asked.features).toBeGreaterThan(before);

    // Normal again: the timer is off.
    const after = asked.features;
    await act(async () => {
      vi.advanceTimersByTime(60 * MODE_POLL.normal);
    });
    expect(asked.features).toBe(after);
  });
});

describe('a deployment in maintenance', () => {
  it('shows one notice instead of the app, which asks for nothing', async () => {
    const { asked } = useDeployment('maintenance');
    await renderApp('/');
    expect(await maintenanceTitle()).toBeVisible();
    expect(screen.getByText(/This page checks again by itself/)).toBeVisible();
    expect(screen.queryByText('Dashboard', { selector: 'h1' })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    // Not the menu's approvals count, not the home page's cards.
    expect(asked.approvals).toBe(0);
    expect(asked.notifications).toBe(0);
  });

  it('shows the notice on any page, not only the home page', async () => {
    useDeployment('maintenance');
    await renderApp('/account/profile');
    expect(await maintenanceTitle()).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('goes by itself to the app once the mode is normal again ("Check again")', async () => {
    const { state } = useDeployment('maintenance');
    await renderApp('/');
    await maintenanceTitle();
    state.mode = 'normal';
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Check again' }));
    expect(await dashboard()).toBeVisible();
    expect(screen.queryByText('Down for maintenance')).toBeNull();
  });

  it('turns into the notice when a request is refused with 503 maintenance', async () => {
    const { state } = useDeployment('normal');
    server.use(
      http.get('/v1/approvals', () => {
        state.mode = 'maintenance';
        return problem(503, 'maintenance');
      }),
    );
    await renderApp('/');
    expect(await maintenanceTitle()).toBeVisible();
    expect(screen.queryByText('Dashboard', { selector: 'h1' })).toBeNull();
  });

  it('lets the user sign out', async () => {
    useDeployment('maintenance');
    let signedOut = false;
    server.use(
      http.post('/v1/auth/sign-out', () => {
        signedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { router } = await renderApp('/');
    await maintenanceTitle();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/sign-in'),
    );
    expect(signedOut).toBe(true);
  });

  it('lets an operator who manages settings end it from the notice', async () => {
    const { state } = useDeployment('maintenance', ['Access.manageSettings']);
    const removed: string[] = [];
    server.use(
      http.delete('/v1/settings/:key/platform', ({ params }) => {
        removed.push(String(params['key']));
        state.mode = 'normal';
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await renderApp('/');
    await maintenanceTitle();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'End maintenance' }));
    await findToast('Maintenance mode is off.');
    expect(removed).toEqual(['platform.mode']);
    expect(await dashboard()).toBeVisible();
  });

  it('says it is still on when the environment sets the mode (APP_MODE)', async () => {
    // The API answers 204 whatever it removed: the stored value goes (or
    // there is none), the environment's mode stays.
    useDeployment('maintenance', ['Access.manageSettings']);
    let removed = 0;
    server.use(
      http.delete('/v1/settings/:key/platform', () => {
        removed += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await renderApp('/');
    await maintenanceTitle();
    expect(screen.getByText(/can only be changed there/)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'End maintenance' }));
    await findToast(/The mode is still on/);
    expect(removed).toBe(1);
    expect(screen.queryByText('Maintenance mode is off.')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Down for maintenance' }),
    ).toBeVisible();
  });

  it('offers no way to end it to a user who may not manage settings', async () => {
    useDeployment('maintenance', ['Note.read']);
    await renderApp('/');
    await maintenanceTitle();
    expect(
      screen.queryByRole('button', { name: 'End maintenance' }),
    ).toBeNull();
  });
});
