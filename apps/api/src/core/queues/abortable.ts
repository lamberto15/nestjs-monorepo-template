/**
 * `work`, or the signal's reason as soon as it aborts (at once if it
 * already has). BullMQ's `add` takes no signal. The queues' producer
 * connection fails an add at once while Redis is unreachable (no offline
 * queue, `producerRedisOptions()`), so an abandoned add is not resent when
 * Redis returns; one already on the wire when the signal aborts may still
 * land: give it a deterministic job id.
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
