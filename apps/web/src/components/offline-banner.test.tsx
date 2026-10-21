import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeRealtime } from '@/test/fake-realtime';
import { renderComponent } from '@/test/render-component';
import { OfflineBanner } from './offline-banner';

const fake = createFakeRealtime();
vi.mock('@/lib/realtime', () => ({ useRealtime: () => fake }));

const setOnline = (value: boolean) => {
  vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(value);
  act(() => {
    globalThis.dispatchEvent(new Event(value ? 'online' : 'offline'));
  });
};

describe('the offline banner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is hidden while online with the socket connecting or connected', async () => {
    await renderComponent(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => fake.emit('connect'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows while the browser is offline and goes when it is back', async () => {
    await renderComponent(<OfflineBanner />);
    setOnline(false);
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
    setOnline(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows when the socket drops while online, until it reconnects', async () => {
    await renderComponent(<OfflineBanner />);
    act(() => fake.emit('disconnect'));
    expect(screen.getByRole('status')).toHaveTextContent(/connection/i);
    act(() => fake.emit('connect'));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
