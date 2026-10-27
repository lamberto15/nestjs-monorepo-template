/**
 * `work`, or the signal's reason as soon as it aborts (at once if it
 * already has). BullMQ's `add` takes no signal and, with
 * `maxRetriesPerRequest: null`, waits as long as Redis is down. The add may
 * still land afterwards: give it a deterministic job id.
 */
export function abortable<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    // The add was already called: its outcome is not awaited.
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work
      .finally(() => signal.removeEventListener('abort', abort))
      .then(resolve, reject);
  });
}
