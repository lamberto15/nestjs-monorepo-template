import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInstallPrompt } from './pwa';

function promptEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });
  return event as Event & { prompt: ReturnType<typeof vi.fn> };
}

describe('useInstallPrompt', () => {
  // The prompt is held at module level, beyond any one hook: start each test without one.
  afterEach(() => {
    act(() => {
      globalThis.dispatchEvent(new Event('appinstalled'));
    });
  });

  it('offers nothing until the browser fires beforeinstallprompt', () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current).toBeUndefined();
  });

  it('holds the prompt, shows it once, then offers nothing', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = promptEvent();
    act(() => {
      globalThis.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(result.current).toBeTypeOf('function');
    await act(async () => {
      await result.current?.();
    });
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(result.current).toBeUndefined();
  });

  it('stops offering once the app is installed', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      globalThis.dispatchEvent(promptEvent());
    });
    expect(result.current).toBeDefined();
    act(() => {
      globalThis.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current).toBeUndefined();
  });

  it('keeps a prompt the browser fired before the hook was mounted', () => {
    // The sign-in page, or the session still loading: no user menu yet.
    const event = promptEvent();
    act(() => {
      globalThis.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current).toBeTypeOf('function');
  });

  it('keeps a prompt fired while the hook is unmounted, for the next mount', () => {
    // Signing out unmounts the user menu; the browser fires the event once.
    const first = renderHook(() => useInstallPrompt());
    first.unmount();
    act(() => {
      globalThis.dispatchEvent(promptEvent());
    });
    const second = renderHook(() => useInstallPrompt());
    expect(second.result.current).toBeTypeOf('function');
  });
});
