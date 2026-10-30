import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedCallback', () => {
  it('schedules nothing once its component is gone', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDebouncedCallback(callback, 250),
    );
    unmount();
    result.current();
    vi.advanceTimersByTime(250);
    expect(callback).not.toHaveBeenCalled();
  });
});
