import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INPUT_EVENTS, useRefreshOnInput } from '@/lib/refresh-on-input';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A query that counts its asks, answered at the fake clock's present. */
function counted(key: string, ask = async () => 'answer') {
  const asked = vi.fn(ask);
  return { asked, options: queryOptions({ queryKey: [key], queryFn: asked }) };
}

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const input = (event = 'pointerdown') =>
  act(async () => {
    window.dispatchEvent(new Event(event));
  });

describe('useRefreshOnInput', () => {
  it('asks again when the user does something, once the answer is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, wrapper } = setup();
    const { asked, options } = counted('layout');
    client.setQueryData(options.queryKey, 'answer');
    renderHook(() => useRefreshOnInput(options), { wrapper });

    await input();
    expect(asked).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    await input('keydown');
    expect(asked).toHaveBeenCalledTimes(1);
    // The new answer is young: a burst of input costs nothing more.
    await input('wheel');
    await input('touchstart');
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('takes the age the caller names', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, wrapper } = setup();
    const { asked, options } = counted('layout');
    client.setQueryData(options.queryKey, 'answer');
    renderHook(() => useRefreshOnInput(options, { minAge: 5_000 }), {
      wrapper,
    });

    vi.advanceTimersByTime(5_000);
    await input();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('listens once on the window, whatever number of queries it keeps fresh', () => {
    const { wrapper } = setup();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const heard = (spy: typeof add) =>
      spy.mock.calls.filter(([type]) =>
        (INPUT_EVENTS as readonly string[]).includes(type),
      ).length;
    const first = renderHook(() => useRefreshOnInput(counted('a').options), {
      wrapper,
    });
    const second = renderHook(() => useRefreshOnInput(counted('b').options), {
      wrapper,
    });
    expect(heard(add)).toBe(INPUT_EVENTS.length);

    first.unmount();
    expect(heard(remove)).toBe(0);
    second.unmount();
    expect(heard(remove)).toBe(INPUT_EVENTS.length);
  });

  it('keeps every query fresh that asked, each by its own age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, wrapper } = setup();
    const a = counted('a');
    const b = counted('b');
    client.setQueryData(a.options.queryKey, 'answer');
    client.setQueryData(b.options.queryKey, 'answer');
    renderHook(
      () => {
        useRefreshOnInput(a.options);
        useRefreshOnInput(b.options, { minAge: 120_000 });
      },
      { wrapper },
    );

    vi.advanceTimersByTime(60_000);
    await input();
    expect(a.asked).toHaveBeenCalledTimes(1);
    expect(b.asked).not.toHaveBeenCalled();
  });

  it('asks nothing while disabled, and again once enabled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, wrapper } = setup();
    const { asked, options } = counted('layout');
    client.setQueryData(options.queryKey, 'answer');
    const view = renderHook(
      (props: { enabled: boolean }) =>
        useRefreshOnInput(options, { enabled: props.enabled }),
      { wrapper, initialProps: { enabled: false } },
    );

    vi.advanceTimersByTime(60_000);
    await input();
    expect(asked).not.toHaveBeenCalled();

    view.rerender({ enabled: true });
    await input();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the ask fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, wrapper } = setup();
    const { asked, options } = counted('layout', async () => {
      throw new Error('down');
    });
    client.setQueryData(options.queryKey, 'answer');
    renderHook(() => useRefreshOnInput(options), { wrapper });

    vi.advanceTimersByTime(60_000);
    await input();
    expect(asked).toHaveBeenCalledTimes(1);
    // The answer from before stays; no unhandled rejection fails the run.
    expect(client.getQueryData(options.queryKey)).toBe('answer');
  });
});
