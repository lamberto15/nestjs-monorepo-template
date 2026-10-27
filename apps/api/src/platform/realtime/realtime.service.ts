import { ApiClientLifecycleRegistry } from '../../iam/access/api-client-lifecycle.registry.js';
import { UserLifecycleRegistry } from '../../iam/auth/user-lifecycle.registry.js';
import { SessionLifecycleRegistry } from '../../iam/auth/session-lifecycle.registry.js';
import { JwtAuth } from '../../iam/auth/jwt-auth.provider.js';
import { TenantLifecycleRegistry } from '../../iam/access/tenant-lifecycle.registry.js';
import { Inject, Logger, Optional, UseInterceptors } from '@nestjs/common';
import { ClsInterceptor } from 'nestjs-cls';
import {
  CurrentUser,
  type JwtClaims,
  WsAuthenticator,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { REALTIME_NAMESPACE } from './realtime-adapter.js';
import { RealtimeEmitter } from './realtime-emitter.js';
import {
  allRealtimeEvents,
  checkRealtimePayload,
  type RealtimeEventDeclaration,
  type RealtimeEventName,
  type RealtimeEventPayload,
} from './realtime-events.js';

/**
 * The room of a principal in a tenant (docs/tenancy.md): every connection
 * of that user or API client acting in that tenant. A user in two tenants
 * has a room in each, and a connection is in its session's tenant's only,
 * so an event of tenant A never reaches a socket opened in tenant B.
 * `tenantId` null: the account room of a user, for what is the person's
 * own whatever the tenant (a security notification sent outside any
 * tenant); every connection of the user is in it. The system principal has
 * none (it never connects): refused.
 */
export const principalRoom = (
  principal: Pick<Principal, 'kind' | 'id'>,
  tenantId: string | null,
) => {
  if (principal.kind === 'system') {
    throw new Error('The system principal has no realtime room.');
  }
  return tenantId
    ? `tenant:${tenantId}:principal:${principalKey(principal)}`
    : `principal:${principalKey(principal)}`;
};

/** A private room for the credential that opened a browser socket. */
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/**
 * A private room for the refresh family whose access token opened a token
 * client's socket: its `sid` claim (tokenClaims()).
 */
export const tokenRoom = (tokenSessionId: string) => `token:${tokenSessionId}`;

/**
 * Realtime events over socket.io, namespace `/realtime`, on every instance
 * (the Redis adapter, realtime-adapter.ts).
 *
 * Who connects: signed-in users (the handshake's session cookie, or a token
 * client's access token: `auth: { token: '<JWT>' }`) and API clients
 * (`auth: { token: 'sk_…' }`); anyone else is refused at the
 * handshake (`connect_error` "unauthorized"; socket.io doesn't retry it).
 * Each connection is in its principal's room of its tenant (and, for a
 * user, their account room) before the client hears it's connected; browser
 * sockets also join their session's private room, a token client's its
 * refresh family's. Revoking a session or a family disconnects its sockets
 * across instances, and a revoked family's access token, still unexpired,
 * opens none. A session's tenant switch
 * issues a new session, and a socket opened before stays in the old tenant's
 * room: reconnect after switching. The global guard authenticates every
 * message again; each message runs in a CLS context with its principal's
 * tenant (ClsInterceptor, set up in CoreModule).
 *
 * Browser: `io('/realtime', { withCredentials: true, transports: ['websocket'] })`.
 *
 * Features inject it to push events:
 *
 * ```ts
 * this.realtime.toPrincipal(owner, 'thumbnail.ready', { fileKey });
 * ```
 *
 * Emit after the change committed (as the notification delivery does), so a
 * client never hears of a change that rolled back. To tell a person something
 * (stored, read later, by mail too), send a notification instead:
 * docs/notifications.md.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
@UseInterceptors(ClsInterceptor)
export class Realtime implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Realtime');
  /** The manifest and the features' events: what may be pushed. */
  private readonly events: Record<string, RealtimeEventDeclaration>;

  @WebSocketServer()
  private readonly server: Namespace;

  constructor(
    private readonly wsAuth: WsAuthenticator,
    private readonly jwtAuth: JwtAuth,
    lifecycle: UserLifecycleRegistry,
    sessionLifecycle: SessionLifecycleRegistry,
    clientLifecycle: ApiClientLifecycleRegistry,
    tenantLifecycle: TenantLifecycleRegistry,
    @Optional()
    @Inject(PLATFORM_OPTIONS)
    options?: Pick<PlatformOptions, 'realtimeEvents'>,
    // Without a socket server (the operator CLI): the API's sockets through Redis.
    @Optional() private readonly emitter?: RealtimeEmitter,
  ) {
    this.events = allRealtimeEvents(options?.realtimeEvents);
    // Revoke sockets for this credential only, across API replicas via Redis.
    sessionLifecycle.register({
      name: 'realtime',
      afterRevocation: (sessionId) => this.disconnect([sessionRoom(sessionId)]),
      // A token client's family: sign-out, a reused refresh token, a
      // re-authentication, signing out everywhere. Its access token would
      // still pass each message's check until it expires, so the socket
      // ends here rather than there.
      afterTokenRevocation: (tokenSessionId) =>
        this.disconnect([tokenRoom(tokenSessionId)]),
    });
    // A membership deactivated: that user's connections in that tenant end
    // (a socket is authenticated at its handshake; its tenant room would
    // keep hearing the tenant's events). After the commit: a deactivation
    // that rolled back disconnects nobody. Every instance's sockets,
    // through the Redis adapter.
    lifecycle.register({
      name: 'realtime',
      afterDeactivation: (userId, tenantId) =>
        this.disconnect([
          principalRoom({ kind: 'user', id: userId }, tenantId),
        ]),
    });
    // A deactivated tenant: every connection in it ends (its members' and
    // API clients' rooms of that tenant; their other tenants' stay).
    tenantLifecycle.register({
      name: 'realtime',
      afterDeactivation: (tenantId, principals) =>
        this.disconnect(
          principals.map((principal) => principalRoom(principal, tenantId)),
        ),
    });
    // A deleted API client: its connections end the same way.
    clientLifecycle.register({
      name: 'realtime',
      afterDeletion: (clientId, tenantId) =>
        this.disconnect([
          principalRoom({ kind: 'client', id: clientId }, tenantId),
        ]),
    });
  }

  /**
   * Ends the sockets in these rooms on every API replica: through this
   * process's socket server (its Redis adapter tells the others), or, in a
   * process without one (the operator CLI), through the Redis emitter.
   */
  private disconnect(rooms: string[]) {
    if (rooms.length === 0) {
      return;
    }
    if (this.server) {
      this.server.in(rooms).disconnectSockets(true);
    } else {
      this.emitter?.disconnect(rooms);
    }
  }

  /**
   * To every connection of a user or an API client in the current
   * context's tenant (a request's, a job's restored from its envelope);
   * outside any tenant, to a user's account room (an API client always has
   * a tenant: nothing to tell outside one).
   */
  toPrincipal<E extends RealtimeEventName>(
    principal: Pick<Principal, 'kind' | 'id'>,
    event: E,
    data: RealtimeEventPayload<E>,
  ): void;
  /** An event a feature declared (`realtimeEvents`): its payload is checked in development and tests, not typed. */
  toPrincipal(
    principal: Pick<Principal, 'kind' | 'id'>,
    event: string,
    data: unknown,
  ): void;
  toPrincipal(
    principal: Pick<Principal, 'kind' | 'id'>,
    event: string,
    data: unknown,
  ) {
    // Development and tests: an undeclared event or a payload off its schema
    // is a bug in the caller, so it fails where it is written. Production
    // sends what it is given (a live event is best-effort, never worth a 500).
    if (process.env.NODE_ENV !== 'production') {
      const problem = checkRealtimePayload(this.events, event, data);
      if (problem) {
        throw new Error(problem);
      }
    }
    if (principal.kind === 'system') {
      return; // never connected: nobody to tell
    }
    const tenantId = currentTenantId();
    if (!tenantId && principal.kind !== 'user') {
      return;
    }
    this.toRoom(principalRoom(principal, tenantId), event, data);
  }

  /**
   * To every connection in a room. Without a socket server, nothing: NestJS
   * sets @WebSocketServer() only in an HTTP application, once its gateways
   * start (docs.nestjs.com websockets/gateways, "Server and Namespace"), so a
   * standalone application context (the demo seed, a script) has the gateway
   * as a provider but no server, and nobody connected to tell. The same
   * check as the lifecycle hooks above. The API and the worker both run the
   * HTTP app, so they always have one.
   */
  toRoom(room: string, event: string, data: unknown) {
    if (!this.server) {
      this.logger.debug(`No socket server: ${event} not sent`);
      return;
    }
    this.server.to(room).emit(event, data);
  }

  /**
   * Authentication in socket.io's middleware, before the connection exists
   * (socket.io's way for auth). Done in handleConnection, as
   * WsAuthenticator's docs show, the client was already connected while it
   * ran: a message it sent at once found no room yet, and events sent to its
   * principal meanwhile were lost.
   */
  afterInit(server: Namespace) {
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        (user) =>
          user
            ? next()
            : next(
                Object.assign(new Error('unauthorized'), {
                  data: { code: 'unauthorized' },
                }),
              ),
        // A failure of ours (a query, the database away): logged here, and
        // the client hears a word only, never the error's text (SQL, hosts).
        (error: unknown) => {
          this.logger.error(
            'Authenticating a realtime connection failed',
            error instanceof Error ? error.stack : String(error),
          );
          next(
            Object.assign(new Error('unavailable'), {
              data: { code: 'unavailable' },
            }),
          );
        },
      );
    });
  }

  private async authenticate(socket: Socket) {
    // An API key in the handshake's auth payload becomes the bearer header the providers read.
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token === 'string' && !socket.handshake.headers.authorization) {
      socket.handshake.headers.authorization = `Bearer ${token}`;
    }
    // Not required here: the refusal is next(error), a connect_error, rather
    // than a disconnect of a socket that isn't connected yet.
    const result = await this.wsAuth.authenticateConnection(socket, undefined, {
      required: false,
    });
    const user = result?.user as Principal | undefined;
    // Never the system principal (PrincipalGuard's rule, here at the handshake).
    if (user?.kind === 'system') {
      return undefined;
    }
    const session = result?.session as
      | { id?: unknown; userId?: unknown; sid?: unknown; sub?: unknown }
      | undefined;
    if (
      user?.kind === 'user' &&
      typeof session?.id === 'string' &&
      session.userId === user.id
    ) {
      socket.data.sessionId = session.id;
    }
    // An access token (JwtAuth: the session is its claims) of a family
    // revoked since it was issued opens nothing: the revocation that would
    // end this socket has happened already.
    if (
      user?.kind === 'user' &&
      typeof session?.sid === 'string' &&
      session.sub === user.id
    ) {
      if (await this.jwtAuth.familyRevoked(session as JwtClaims)) {
        return undefined;
      }
      socket.data.tokenSessionId = session.sid;
    }
    socket.data.principal = user;
    return user;
  }

  /** Synchronous: the room is joined before the client can send or miss anything. */
  handleConnection(client: Socket) {
    const user = client.data.principal as Principal | undefined;
    if (user && user.kind !== 'system') {
      const rooms = [
        ...(user.tenantId ? [principalRoom(user, user.tenantId)] : []),
        // The account room (the person's own events, across tenants): never
        // for an administrator acting as them in one tenant.
        ...(user.kind === 'user' && !user.impersonator
          ? [principalRoom(user, null)]
          : []),
      ];
      if (typeof client.data.sessionId === 'string') {
        rooms.push(sessionRoom(client.data.sessionId));
      }
      if (typeof client.data.tokenSessionId === 'string') {
        rooms.push(tokenRoom(client.data.tokenSessionId));
      }
      void client.join(rooms);
      this.logger.debug(`Connected: ${principalKey(user)}`);
      if (typeof client.data.tokenSessionId === 'string') {
        this.recheckFamily(client, user.id, client.data.tokenSessionId);
      }
    }
  }

  /**
   * The handshake asked whether the family was revoked before the socket
   * was in its room: a revocation in between disconnected nobody. Asked
   * again now that it is in the room, so one of the two always sees it.
   */
  private recheckFamily(client: Socket, userId: string, sid: string) {
    void this.jwtAuth.familyRevoked({ sub: userId, sid }).then(
      (revoked) => {
        if (revoked) {
          client.disconnect(true);
        }
      },
      (error: unknown) => {
        // Unsure: the socket ends rather than outlive a revocation.
        this.logger.error(
          'Checking a realtime connection again failed',
          error instanceof Error ? error.stack : String(error),
        );
        client.disconnect(true);
      },
    );
  }

  /** `socket.emitWithAck('whoami')`: who this connection acts as. */
  @Can.Anyone()
  @SubscribeMessage('whoami')
  whoami(@CurrentUser() user: Principal, @ConnectedSocket() client: Socket) {
    return {
      kind: user.kind,
      id: user.id,
      tenantId: user.kind === 'system' ? null : user.tenantId,
      rooms: [...client.rooms].filter((room) => room !== client.id),
    };
  }
}
