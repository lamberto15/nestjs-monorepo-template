import { ApiClientLifecycleRegistry } from '../../iam/access/api-client-lifecycle.registry.js';
import { UserLifecycleRegistry } from '../../iam/auth/user-lifecycle.registry.js';
import { Logger, UseInterceptors } from '@nestjs/common';
import { ClsInterceptor } from 'nestjs-cls';
import { CurrentUser, WsAuthenticator } from '@nestjs/authentication';
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

/**
 * Realtime events over socket.io, namespace `/realtime`, on every instance
 * (the Redis adapter, realtime-adapter.ts).
 *
 * Who connects: signed-in users (the handshake's session cookie) and API
 * clients (`auth: { token: 'sk_…' }`); anyone else is refused at the
 * handshake (`connect_error` "unauthorized"; socket.io doesn't retry it).
 * Each connection is in its principal's room of its tenant (and, for a
 * user, their account room) before the client hears it's connected; a
 * session's tenant switch issues a new session, and a socket opened before
 * stays in the old tenant's room: reconnect after switching. The global
 * guard authenticates every message again, so a revoked session or key
 * stops working mid-connection; each message runs in a CLS context with
 * its principal's tenant (ClsInterceptor, set up in CoreModule).
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
@WebSocketGateway({ namespace: 'realtime' })
@UseInterceptors(ClsInterceptor)
export class Realtime implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Realtime');

  @WebSocketServer()
  private readonly server: Namespace;

  constructor(
    private readonly wsAuth: WsAuthenticator,
    lifecycle: UserLifecycleRegistry,
    clientLifecycle: ApiClientLifecycleRegistry,
  ) {
    // A membership deactivated: that user's connections in that tenant end
    // (a socket is authenticated at its handshake; its tenant room would
    // keep hearing the tenant's events). After the commit: a deactivation
    // that rolled back disconnects nobody. Every instance's sockets,
    // through the Redis adapter.
    lifecycle.register({
      name: 'realtime',
      afterDeactivation: (userId, tenantId) => {
        if (this.server) {
          this.server
            .in(principalRoom({ kind: 'user', id: userId }, tenantId))
            .disconnectSockets(true);
        }
      },
    });
    // A deleted API client: its connections end the same way.
    clientLifecycle.register({
      name: 'realtime',
      afterDeletion: (clientId, tenantId) => {
        if (this.server) {
          this.server
            .in(principalRoom({ kind: 'client', id: clientId }, tenantId))
            .disconnectSockets(true);
        }
      },
    });
  }

  /**
   * To every connection of a user or an API client in the current
   * context's tenant (a request's, a job's restored from its envelope);
   * outside any tenant, to a user's account room (an API client always has
   * a tenant: nothing to tell outside one).
   */
  toPrincipal(
    principal: Pick<Principal, 'kind' | 'id'>,
    event: string,
    data: unknown,
  ) {
    if (principal.kind === 'system') {
      return; // never connected: nobody to tell
    }
    const tenantId = currentTenantId();
    if (!tenantId && principal.kind !== 'user') {
      return;
    }
    this.server.to(principalRoom(principal, tenantId)).emit(event, data);
  }

  /** To every connection in a room. */
  toRoom(room: string, event: string, data: unknown) {
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
        (error: unknown) => next(error as Error),
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
      void client.join(rooms);
      this.logger.debug(`Connected: ${principalKey(user)}`);
    }
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
