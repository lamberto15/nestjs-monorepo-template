import {
  io,
  type ManagerOptions,
  type Socket,
  type SocketOptions,
} from 'socket.io-client';
import type { GetResponse } from './client.js';

/** A notification as `GET /v1/notifications` lists it, and as the `notification` event carries it. */
export type NotificationItem =
  GetResponse<'/v1/notifications'>['items'][number];

/** `{ unread }`, as `GET /v1/notifications/unread-count` answers. */
export type UnreadCount = GetResponse<'/v1/notifications/unread-count'>;

/**
 * Every event the API pushes on `/realtime` (docs/notifications.md,
 * docs/data-transfer.md, docs/bulk-operations.md, docs/approvals.md). A feature that adds one
 * (`Realtime.toPrincipal(principal, event, data)`) adds it here.
 */
export interface RealtimeEvents {
  /** A new notification, in the recipient's language. */
  notification: (item: NotificationItem) => void;
  'notification.read': (event: { id: string; readAt: string | null }) => void;
  /** `before`: what the call passed (null: all of them); `updated`: how many changed. */
  'notifications.read-all': (event: {
    before: string | null;
    updated: number;
  }) => void;
  'notification.removed': (event: { id: string }) => void;
  /** After each of the above and each delivery: the badge's number. */
  'notifications.unread-count': (event: UnreadCount) => void;
  /** An export is ready: `url` is a signed link to the file. */
  'data.export-ready': (event: {
    id: string;
    name: string;
    rows: number;
    url: string;
  }) => void;
  'data.import-finished': (event: {
    id: string;
    name: string;
    rows: number;
    imported: number;
    failed: number;
  }) => void;
  /** An approval request waits for you (or for someone you stand in for): `GET /v1/approvals/{id}` (docs/approvals.md). */
  'approval.assigned': (event: {
    id: string;
    subject: string;
    recordId: string;
    action: string;
    stage: number;
  }) => void;
  /**
   * A decision on a request you made or decide, or its end: `status` is the
   * request's after it (pending while stages remain); `decision` null when no
   * person decided (cancelled, expired, failed).
   */
  'approval.decided': (event: {
    id: string;
    status:
      | 'pending'
      | 'approved'
      | 'rejected'
      | 'changes_requested'
      | 'cancelled'
      | 'expired'
      | 'failed';
    round: number;
    stage: number;
    decision: 'approved' | 'rejected' | 'changes_requested' | null;
  }) => void;
  /** A queued bulk operation ended; its item results: `GET /v1/bulk/{id}` (docs/bulk-operations.md). */
  'bulk.finished': (event: {
    id: string;
    name: string;
    action: string;
    done: number;
    failed: number;
  }) => void;
  /**
   * A document you asked for (`POST /v1/notes/{id}/pdf`) was issued: the PDF
   * is the record's attachment `attachmentId` (docs/documents.md).
   */
  'document.ready': (event: {
    id: string;
    subject: string;
    recordId: string;
    attachmentId: string;
  }) => void;
  /**
   * A comment on a record you watch (or one you wrote, for your other tabs)
   * was added, edited or removed: ids only, fetch the thread
   * (docs/webhooks-and-realtime.md, "Record events").
   */
  'record.commented': (event: {
    subject: string;
    recordId: string;
    commentId: string;
    action: 'added' | 'edited' | 'removed';
  }) => void;
  /** A file on a record you watch was uploaded, removed or issued (a PDF): ids only. */
  'record.attachments.changed': (event: {
    subject: string;
    recordId: string;
    attachmentId: string;
    action: 'added' | 'removed';
  }) => void;
  /** A document you asked for failed for good; `error` says why, for people. */
  'document.failed': (event: {
    id: string;
    subject: string;
    recordId: string;
    error: string;
  }) => void;
}

/** What a connection may ask the API. */
export interface RealtimeRequests {
  /** Who this connection acts as, and its rooms. */
  whoami: (
    ack: (answer: {
      kind: 'user' | 'client';
      id: string;
      rooms: string[];
    }) => void,
  ) => void;
}

export type RealtimeSocket = Socket<RealtimeEvents, RealtimeRequests>;

export interface RealtimeOptions {
  /** The API's origin (`https://api.example.com`); the namespace `/realtime` is added. */
  url: string;
  /**
   * An API key (`sk_…`) or a user access token. A function is asked on every
   * (re)connection, so a renewed token is used. Without one, the browser's
   * session cookie is sent (`withCredentials`).
   */
  token?: string | (() => string | Promise<string>);
  /** Anything else socket.io-client takes (`autoConnect`, `reconnectionDelay`…). */
  socket?: Partial<ManagerOptions & SocketOptions>;
}

export interface Realtime {
  /** The socket.io socket, typed with the API's events. */
  readonly socket: RealtimeSocket;
  on<E extends keyof RealtimeEvents>(
    event: E,
    handler: RealtimeEvents[E],
  ): () => void;
  off<E extends keyof RealtimeEvents>(
    event: E,
    handler: RealtimeEvents[E],
  ): void;
  /** Resolves once connected; rejects when the API refuses the connection. */
  connected(): Promise<void>;
  whoami(): Promise<{ kind: 'user' | 'client'; id: string; rooms: string[] }>;
  close(): void;
}

/**
 * `url` without its trailing slashes. A loop, not `replace(/\/+$/, '')`:
 * that regex is quadratic on a URL made of many slashes (CodeQL
 * js/polynomial-redos), and the URL is whatever the caller passes.
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end--;
  }
  return url.slice(0, end);
}

/**
 * A connection to the API's realtime events (socket.io, `/realtime`), over
 * WebSocket only: no long-polling, so no sticky sessions needed.
 */
export function createRealtime(options: RealtimeOptions): Realtime {
  const { token } = options;
  const socket: RealtimeSocket = io(
    `${trimTrailingSlashes(options.url)}/realtime`,
    {
      transports: ['websocket'],
      ...(token === undefined
        ? { withCredentials: true }
        : {
            auth: (callback: (data: object) => void) => {
              void Promise.resolve(
                typeof token === 'function' ? token() : token,
              ).then(
                (value) => callback({ token: value }),
                () => callback({}),
              );
            },
          }),
      ...options.socket,
    },
  );

  return {
    socket,
    on(event, handler) {
      socket.on(event, handler as never);
      return () => socket.off(event, handler as never);
    },
    off(event, handler) {
      socket.off(event, handler as never);
    },
    connected() {
      if (socket.connected) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off('connect_error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          socket.off('connect', onConnect);
          reject(error);
        };
        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
      });
    },
    whoami() {
      return socket.emitWithAck('whoami');
    },
    close() {
      socket.close();
    },
  };
}

export interface NotificationHandlers {
  /** A new notification: add it to the top of the list. */
  onItem?: (item: NotificationItem) => void;
  /** The unread count changed: the bell's badge. */
  onUnread?: (unread: number) => void;
  onRead?: (event: { id: string; readAt: string | null }) => void;
  onReadAll?: (event: { before: string | null; updated: number }) => void;
  onRemoved?: (id: string) => void;
}

/**
 * A bell icon's events, framework-agnostic: pass setters of your state. Load
 * the initial count with `GET /v1/notifications/unread-count`; the events
 * keep it current. Returns the function that stops listening.
 */
export function watchNotifications(
  realtime: Realtime,
  handlers: NotificationHandlers,
): () => void {
  const stops = [
    handlers.onItem && realtime.on('notification', handlers.onItem),
    handlers.onUnread &&
      realtime.on('notifications.unread-count', ({ unread }) =>
        handlers.onUnread!(unread),
      ),
    handlers.onRead && realtime.on('notification.read', handlers.onRead),
    handlers.onReadAll &&
      realtime.on('notifications.read-all', handlers.onReadAll),
    handlers.onRemoved &&
      realtime.on('notification.removed', ({ id }) => handlers.onRemoved!(id)),
  ];
  return () => {
    for (const stop of stops) {
      stop?.();
    }
  };
}
