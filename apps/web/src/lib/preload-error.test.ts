import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForPreloadErrors } from '@/lib/preload-error';
import { reloadForBuildUpdate } from '@/lib/sw-update';

vi.mock('@/lib/sw-update', () => ({ reloadForBuildUpdate: vi.fn() }));

/** What Vite dispatches when a chunk of the build fails to load. */
const missingChunk = () => {
  const event = new Event('vite:preloadError', {
    cancelable: true,
  }) as VitePreloadErrorEvent;
  event.payload = new Error('Failed to fetch dynamically imported module');
  window.dispatchEvent(event);
  return event;
};

let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  sessionStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stop = listenForPreloadErrors(window);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(reloadForBuildUpdate).mockClear();
});

describe('a chunk of the build this tab started with is gone', () => {
  it('reloads once into the new build, then lets the next failure show', () => {
    expect(missingChunk().defaultPrevented).toBe(true);
    expect(reloadForBuildUpdate).toHaveBeenCalledOnce();

    // Still missing after the reload: no loop, the route's error page.
    vi.advanceTimersByTime(5_000);
    expect(missingChunk().defaultPrevented).toBe(false);
    expect(reloadForBuildUpdate).toHaveBeenCalledOnce();
  });

  it('reloads again for a later deploy', () => {
    missingChunk();
    vi.advanceTimersByTime(61_000);
    missingChunk();
    expect(reloadForBuildUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps the guard in memory when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    // Well past the reloads the tests above left in this module's memory.
    vi.advanceTimersByTime(10 * 60_000);
    missingChunk();
    missingChunk();
    expect(reloadForBuildUpdate).toHaveBeenCalledOnce();
  });
});
