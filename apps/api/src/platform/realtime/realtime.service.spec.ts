import { Logger } from '@nestjs/common';
import type {
  AuthenticationResult,
  WsAuthenticator,
} from '@nestjs/authentication';
import type { Namespace, Socket } from 'socket.io';
import type { ApiClientLifecycleRegistry } from '../../iam/access/api-client-lifecycle.registry.js';
import type { TenantLifecycleRegistry } from '../../iam/access/tenant-lifecycle.registry.js';
import type { UserLifecycleRegistry } from '../../iam/auth/user-lifecycle.registry.js';
import {
  SessionLifecycleRegistry,
  type SessionLifecycleListener,
} from '../../iam/auth/session-lifecycle.registry.js';
import type { JwtAuth } from '../../iam/auth/jwt-auth.provider.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { PeopleService } from '../people/people.service.js';
import type { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { z } from 'zod';
import { defineRealtimeEvent } from './realtime-events.js';
import { RecordActivity } from './record-activity.js';
import { Realtime, tokenRoom } from './realtime.service.js';

/**
 * The gateway as a standalone application context has it (the demo seed):
 * a provider whose @WebSocketServer() NestJS never set.
 */
const serverless = () =>
  new Realtime(
    {} as WsAuthenticator,
    {} as JwtAuth,
    { register: vi.fn() } as unknown as UserLifecycleRegistry,
    { register: vi.fn() } as unknown as SessionLifecycleRegistry,
    { register: vi.fn() } as unknown as ApiClientLifecycleRegistry,
    { register: vi.fn() } as unknown as TenantLifecycleRegistry,
  );

const user: Principal = { kind: 'user', id: 'u1' } as Principal;

describe('Realtime without a socket server', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends nothing, and neither throws nor warns', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const realtime = serverless();

    expect(() =>
      realtime.toPrincipal(user, 'notification.removed', { id: 'n1' }),
    ).not.toThrow();
    expect(() => realtime.toRoom('a-room', 'some.event', {})).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets a record activity push through without a warning (#158)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const activity = new RecordActivity(
      serverless(),
      {
        watchers: vi.fn().mockResolvedValue(['user:u2']),
      } as unknown as SubscriptionsService,
      {
        principal: vi
          .fn()
          .mockResolvedValue({ kind: 'user', id: 'u2' } as Principal),
      } as unknown as PeopleService,
    );

    await activity.push(
      { subject: 'Note', recordId: 'r1' },
      'record.commented',
      { commentId: 'c1', action: 'added' },
      { by: user, canRead: () => Promise.resolve(true) },
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns when a push really fails', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const activity = new RecordActivity(
      serverless(),
      {
        watchers: vi.fn().mockRejectedValue(new Error('database away')),
      } as unknown as SubscriptionsService,
      {} as PeopleService,
    );

    await activity.push(
      { subject: 'Note', recordId: 'r1' },
      'record.commented',
      { commentId: 'c1', action: 'added' },
      { by: user, canRead: () => Promise.resolve(true) },
    );

    expect(warn).toHaveBeenCalledWith(
      'record.commented was not pushed',
      expect.objectContaining({ error: 'Error: database away' }),
    );
  });
});

describe('Realtime declared events', () => {
  const realtimeWith = (realtimeEvents = {}) =>
    new Realtime(
      {} as WsAuthenticator,
      {} as JwtAuth,
      { register: vi.fn() } as unknown as UserLifecycleRegistry,
      { register: vi.fn() } as unknown as SessionLifecycleRegistry,
      { register: vi.fn() } as unknown as ApiClientLifecycleRegistry,
      { register: vi.fn() } as unknown as TenantLifecycleRegistry,
      { realtimeEvents },
    );

  it('refuses an undeclared event and a payload off its schema (development and tests)', () => {
    const realtime = realtimeWith();
    expect(() => realtime.toPrincipal(user, 'some.event', {})).toThrow(
      /not declared/,
    );
    expect(() =>
      realtime.toPrincipal(user, 'notification.removed', {} as never),
    ).toThrow(/payload/);
  });

  it('takes a feature event once it is declared', () => {
    const realtime = realtimeWith({
      'thumbnail.ready': defineRealtimeEvent(
        'RealtimeThumbnailReadyEvent',
        'A thumbnail is ready.',
        z.object({ fileKey: z.string() }),
      ),
    });
    expect(() =>
      realtime.toPrincipal(user, 'thumbnail.ready', { fileKey: 'k' }),
    ).not.toThrow();
    expect(() =>
      realtime.toPrincipal(user, 'thumbnail.ready', { fileKey: 1 }),
    ).toThrow(/payload/);
  });

  it('refuses a feature event named like a platform one', () => {
    expect(() =>
      realtimeWith({
        'bulk.failed': defineRealtimeEvent('X', 'x', z.object({})),
      }),
    ).toThrow(/already a platform event/);
  });
});

describe('Realtime and revoked token families', () => {
  const principal = {
    kind: 'user',
    id: 'u1',
    tenantId: 't1',
  } as unknown as Principal;

  /** The gateway with a socket server whose middleware and rooms the test reads. */
  function gateway(
    result: Partial<AuthenticationResult<Principal>> | null,
    revoked = false,
  ) {
    const sessions = new SessionLifecycleRegistry();
    const familyRevoked = vi.fn().mockResolvedValue(revoked);
    const disconnectSockets = vi.fn();
    const inRoom = vi.fn(() => ({ disconnectSockets }));
    let middleware:
      ((socket: Socket, next: (error?: Error) => void) => void) | undefined;
    const server = {
      use: vi.fn((fn: typeof middleware) => (middleware = fn)),
      in: inRoom,
    } as unknown as Namespace;
    const realtime = new Realtime(
      {
        authenticateConnection: vi.fn().mockResolvedValue(result),
      } as unknown as WsAuthenticator,
      { familyRevoked } as unknown as JwtAuth,
      { register: vi.fn() } as unknown as UserLifecycleRegistry,
      sessions,
      { register: vi.fn() } as unknown as ApiClientLifecycleRegistry,
      { register: vi.fn() } as unknown as TenantLifecycleRegistry,
    );
    (realtime as unknown as { server: Namespace }).server = server;
    realtime.afterInit(server);
    /** Runs the handshake, then the connection: the error, or the rooms joined. */
    const connect = async () => {
      const join = vi.fn();
      const socket = {
        handshake: { auth: { token: 'a.b.c' }, headers: {} },
        data: {},
        join,
      } as unknown as Socket;
      const error = await new Promise<Error | undefined>((resolve) =>
        middleware!(socket, resolve),
      );
      if (error) {
        return { error };
      }
      realtime.handleConnection(socket);
      return { rooms: join.mock.calls[0]?.[0] as string[] };
    };
    return {
      realtime,
      sessions,
      familyRevoked,
      inRoom,
      disconnectSockets,
      connect,
    };
  }

  it("puts a token client's socket in its family's room", async () => {
    const { connect, familyRevoked } = gateway({
      user: principal,
      session: { sub: 'u1', sid: 'family-1' },
    });

    const { rooms } = await connect();

    expect(familyRevoked).toHaveBeenCalledWith({ sub: 'u1', sid: 'family-1' });
    expect(rooms).toContain(tokenRoom('family-1'));
  });

  it('refuses the access token of a revoked family at the handshake', async () => {
    const { connect } = gateway(
      { user: principal, session: { sub: 'u1', sid: 'family-1' } },
      true,
    );

    const { error } = await connect();

    expect(error?.message).toBe('unauthorized');
  });

  it("joins no family room for a token without a sid, or another user's", async () => {
    for (const session of [{ sub: 'u1' }, { sub: 'u2', sid: 'family-1' }]) {
      const { connect, familyRevoked } = gateway({ user: principal, session });
      const { rooms } = await connect();
      expect(familyRevoked).not.toHaveBeenCalled();
      expect(rooms!.some((room) => room.startsWith('token:'))).toBe(false);
    }
  });

  it("disconnects the family's sockets when it is revoked, and only them", async () => {
    const { sessions, inRoom, disconnectSockets } = gateway(null);

    await sessions.afterTokenRevocation('family-1');

    expect(inRoom).toHaveBeenCalledWith(tokenRoom('family-1'));
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('tells a listener without a token hook nothing', async () => {
    const sessions = new SessionLifecycleRegistry();
    const afterRevocation = vi.fn();
    const listener: SessionLifecycleListener = {
      name: 'sessions-only',
      afterRevocation,
    };
    sessions.register(listener);

    await expect(sessions.afterTokenRevocation('family-1')).resolves.toBe(
      undefined,
    );
    expect(afterRevocation).not.toHaveBeenCalled();
  });
});
