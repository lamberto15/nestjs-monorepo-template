import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
});
