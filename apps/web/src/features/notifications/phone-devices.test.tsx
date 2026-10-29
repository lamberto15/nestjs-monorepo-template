import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';

/** The messaging routes as the API serves them; writes change what a read brings. */
function messagingApi(
  options: {
    phone?: { phone: string | null; verified: boolean; optedOut: boolean };
    verifyFails?: boolean;
    publicKey?: string | null;
  } = {},
) {
  const state = {
    phone: options.phone ?? { phone: null, verified: false, optedOut: false },
    setBodies: [] as unknown[],
    verifyBodies: [] as unknown[],
    removedPhone: 0,
    devices: [
      {
        id: 'd1',
        platform: 'ios',
        name: 'Ada iPhone',
        lastSeenAt: '2026-10-19T09:00:00.000Z',
        createdAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    removedDevices: [] as string[],
    registered: [] as unknown[],
  };
  server.use(
    http.get('/v1/auth/me', () => HttpResponse.json(signedInUser)),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/notifications/types', () => HttpResponse.json({ items: [] })),
    http.get('/v1/notifications/preferences', () =>
      HttpResponse.json({ types: {} }),
    ),
    http.get('/v1/messaging/phone', () => HttpResponse.json(state.phone)),
    http.put('/v1/messaging/phone', async ({ request }) => {
      const body = (await request.json()) as { phone: string };
      state.setBodies.push(body);
      state.phone = { phone: '+49•••••78', verified: false, optedOut: false };
      return HttpResponse.json(state.phone);
    }),
    http.post('/v1/messaging/phone/verify', async ({ request }) => {
      state.verifyBodies.push(await request.json());
      if (options.verifyFails) {
        return problem(400, 'code_invalid');
      }
      state.phone = { ...state.phone, verified: true };
      return HttpResponse.json(state.phone);
    }),
    http.delete('/v1/messaging/phone', () => {
      state.removedPhone++;
      state.phone = { phone: null, verified: false, optedOut: false };
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/v1/devices/web-push', () =>
      HttpResponse.json({ publicKey: options.publicKey ?? null }),
    ),
    http.put('/v1/devices', async ({ request }) => {
      const body = (await request.json()) as { platform: 'web'; name: string };
      state.registered.push(body);
      const device = {
        id: 'd2',
        platform: body.platform,
        name: body.name,
        lastSeenAt: '2026-10-29T09:00:00.000Z',
        createdAt: '2026-10-29T09:00:00.000Z',
      };
      state.devices = [...state.devices, device];
      return HttpResponse.json(device);
    }),
    http.get('/v1/devices', () => HttpResponse.json({ items: state.devices })),
    http.delete('/v1/devices/:id', ({ params }) => {
      state.removedDevices.push(String(params.id));
      state.devices = state.devices.filter((d) => d.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

describe('the SMS number', () => {
  it('adds a number, confirms the code and removes it', async () => {
    const state = messagingApi();
    const user = userEvent.setup();
    await renderApp('/account/notifications');

    await user.type(
      await screen.findByRole('textbox', { name: 'Phone number' }),
      '+4915112345678',
    );
    await user.click(screen.getByRole('button', { name: 'Add number' }));
    await findToast('We texted you a code.');
    expect(state.setBodies).toEqual([{ phone: '+4915112345678' }]);
    expect(await screen.findByText('Not confirmed')).toBeVisible();

    await user.type(
      await screen.findByRole('textbox', { name: 'Code' }),
      '123456',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm number' }));
    await waitFor(() =>
      expect(state.verifyBodies).toEqual([{ code: '123456' }]),
    );
    await findToast('Number confirmed.');
    expect(await screen.findByText('Confirmed')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await findToast('Number removed.');
    expect(state.removedPhone).toBe(1);
    expect(
      await screen.findByRole('textbox', { name: 'Phone number' }),
    ).toBeVisible();
  });

  it('rejects a number without a country code before asking the API', async () => {
    const state = messagingApi();
    const user = userEvent.setup();
    await renderApp('/account/notifications');
    await user.type(
      await screen.findByRole('textbox', { name: 'Phone number' }),
      '015112345678',
    );
    await user.click(screen.getByRole('button', { name: 'Add number' }));
    expect(
      await screen.findByText(/Enter the number with its country code/),
    ).toBeVisible();
    expect(state.setBodies).toEqual([]);
  });

  it('says a wrong code is wrong', async () => {
    messagingApi({
      phone: { phone: '+49•••••78', verified: false, optedOut: false },
      verifyFails: true,
    });
    const user = userEvent.setup();
    await renderApp('/account/notifications');
    await user.type(
      await screen.findByRole('textbox', { name: 'Code' }),
      '000000',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm number' }));
    expect(await screen.findByRole('alert')).toBeVisible();
  });

  it('shows a number that replied STOP', async () => {
    messagingApi({
      phone: { phone: '+49•••••78', verified: true, optedOut: true },
    });
    await renderApp('/account/notifications');
    expect(await screen.findByText('Stopped (STOP)')).toBeVisible();
    expect(screen.getByText(/Reply START/)).toBeVisible();
  });
});

describe('the devices', () => {
  it('lists the devices and removes one', async () => {
    const state = messagingApi();
    const user = userEvent.setup();
    await renderApp('/account/notifications');
    expect(await screen.findByText('Ada iPhone')).toBeVisible();
    expect(screen.getByText('iOS')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove Ada iPhone' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await findToast('Device removed.');
    expect(state.removedDevices).toEqual(['d1']);
    expect(await screen.findByText('No devices registered.')).toBeVisible();
  });
});

/** A browser with a service worker and the Push API; `permission` is what the prompt answers. */
function fakeBrowserPush(permission: NotificationPermission = 'granted') {
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    }),
    unsubscribe: vi.fn(async () => {
      current = null;
      return true;
    }),
  };
  let current: typeof subscription | null = null;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: vi.fn(async () => (current = subscription)),
  };
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    requestPermission: vi.fn(async () => permission),
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager }) },
  });
  return { pushManager, subscription };
}

describe('push on this browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    localStorage.clear();
  });

  it('is not offered while Web Push is off', async () => {
    messagingApi({ publicKey: null });
    fakeBrowserPush();
    await renderApp('/account/notifications');
    expect(await screen.findByText('Ada iPhone')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Enable on this browser' }),
    ).toBeNull();
  });

  it('subscribes this browser and registers it, then turns it off again', async () => {
    const state = messagingApi({ publicKey: 'BKey' });
    const push = fakeBrowserPush();
    const user = userEvent.setup();
    await renderApp('/account/notifications');

    await user.click(
      await screen.findByRole('button', { name: 'Enable on this browser' }),
    );
    await findToast('Push notifications are on for this browser.');
    expect(push.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: 'BKey',
    });
    expect(state.registered).toEqual([
      {
        platform: 'web',
        name: expect.any(String),
        token: JSON.stringify(push.subscription.toJSON()),
      },
    ]);

    await user.click(
      await screen.findByRole('button', { name: 'Disable on this browser' }),
    );
    await findToast('Push notifications are off for this browser.');
    expect(push.subscription.unsubscribe).toHaveBeenCalled();
    expect(state.removedDevices).toEqual(['d2']);
    expect(
      await screen.findByRole('button', { name: 'Enable on this browser' }),
    ).toBeVisible();
  });

  it('says so when the browser blocks notifications', async () => {
    const state = messagingApi({ publicKey: 'BKey' });
    const push = fakeBrowserPush('denied');
    const user = userEvent.setup();
    await renderApp('/account/notifications');
    await user.click(
      await screen.findByRole('button', { name: 'Enable on this browser' }),
    );
    await findToast(/The browser blocked notifications/);
    expect(push.pushManager.subscribe).not.toHaveBeenCalled();
    expect(state.registered).toEqual([]);
  });
});
