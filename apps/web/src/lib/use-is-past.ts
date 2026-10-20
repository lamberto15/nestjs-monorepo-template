import { useEffect, useState } from 'react';

/** Whether `time` has come, re-evaluated when it does (and when `time` changes). */
export function useIsPast(time: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!time) return;
    const left = new Date(time).getTime() - Date.now();
    // setTimeout holds at most 2^31 ms; a later time is re-checked then.
    const id = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(left, 0), 2 ** 31 - 1),
    );
    return () => clearTimeout(id);
  }, [time]);
  return !!time && new Date(time).getTime() <= now;
}
