import { Logger } from '@nestjs/common';
import type { WsAuthenticator } from '@nestjs/authentication';
import type { ApiClientLifecycleRegistry } from '../../iam/access/api-client-lifecycle.registry.js';
import type { TenantLifecycleRegistry } from '../../iam/access/tenant-lifecycle.registry.js';
import type { UserLifecycleRegistry } from '../../iam/auth/user-lifecycle.registry.js';
import type { SessionLifecycleRegistry } from '../../iam/auth/session-lifecycle.registry.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { PeopleService } from '../people/people.service.js';
import type { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { z } from 'zod';
import { defineRealtimeEvent } from './realtime-events.js';
import { RecordActivity } from './record-activity.js';
import { Realtime } from './realtime.service.js';

/**
 * The gateway as a standalone application context has it (the demo seed):
 * a provider whose @WebSocketServer() NestJS never set.
 */
const serverless = () =>
  new Realtime(
    {} as WsAuthenticator,
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
