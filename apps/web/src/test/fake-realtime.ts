import type { Realtime } from '@nestjs-monorepo-template/api-client';

type Handler = (...args: unknown[]) => void;

/**
 * A stand-in for `createRealtime`'s result: tests emit what the API would
 * push (`fake.emit('notifications.unread-count', { unread: 5 })`), and
 * `emit('connect')` plays a (re)connection of the socket
 * (it is not connected until then) and `emit('disconnect')` a drop.
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
      // The socket's own flag, set before its handlers run (socket.io does too).
      if (event === 'connect') fake.socket.connected = true;
      if (event === 'disconnect') fake.socket.connected = false;
      // A copy: a handler may unsubscribe while the event is delivered.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const handler of [...(listeners.get(event) ?? [])]) {
        handler(...args);
      }
    },
    socket: {
      connected: false,
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
