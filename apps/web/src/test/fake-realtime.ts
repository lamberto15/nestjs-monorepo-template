import type { Realtime } from '@nestjs-monorepo-template/api-client';

type Handler = (...args: unknown[]) => void;

/**
 * A stand-in for `createRealtime`'s result: tests emit what the API would
 * push (`fake.emit('notifications.unread-count', { unread: 5 })`), and
 * `emit('connect')` plays a (re)connection of the socket.
 */
export function createFakeRealtime() {
  const listeners = new Map<string, Set<Handler>>();
  const add = (event: string, handler: Handler) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
  };
  const remove = (event: string, handler: Handler) =>
    listeners.get(event)?.delete(handler);
  const fake = {
    closed: false,
    connects: 0,
    emit(event: string, ...args: unknown[]) {
      for (const handler of [...(listeners.get(event) ?? [])]) {
        handler(...args);
      }
    },
    socket: {
      on: add,
      off: remove,
      connect: () => {
        fake.connects++;
      },
    },
    on(event: string, handler: Handler) {
      add(event, handler);
      return () => remove(event, handler);
    },
    off: remove,
    close() {
      fake.closed = true;
    },
  };
  return fake as unknown as typeof fake & Realtime;
}

export type FakeRealtime = ReturnType<typeof createFakeRealtime>;
