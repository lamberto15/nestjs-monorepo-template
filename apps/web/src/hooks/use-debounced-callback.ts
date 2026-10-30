import * as React from 'react';

export function useDebouncedCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  delay: number,
) {
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;

  const debounceTimerRef = React.useRef(0);
  // A caller can still fire after unmount (a combobox hands its text over a
  // frame later): no timer then, or it would run against a torn-down page.
  const mountedRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return React.useCallback(
    (...args: Parameters<T>) => {
      window.clearTimeout(debounceTimerRef.current);
      if (!mountedRef.current) return;
      debounceTimerRef.current = window.setTimeout(
        () => callbackRef.current(...args),
        delay,
      );
    },
    [delay],
  );
}
