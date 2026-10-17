import { ForbiddenException } from '@nestjs/common';
import type { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import type { Principal } from '../../iam/auth/principal.js';
import { SubscriptionsRegistry } from './subscriptions.registry.js';
import { SubscriptionsService } from './subscriptions.service.js';

/** watch(): the feature's SubscriptionTarget decides, before anything is written. */
describe('SubscriptionsService.watch', () => {
  const user = { kind: 'user', id: 'u1' } as Principal;
  const make = () => {
    const registry = new SubscriptionsRegistry();
    const purges = {
      register: () => undefined,
    } as unknown as RecordPurgeRegistry;
    // No database: a refused or unknown subject never reaches subscribe().
    const service = new SubscriptionsService(
      null as never,
      null as never,
      registry,
      purges,
    );
    return { registry, service };
  };

  it('stops at the target that refuses', async () => {
    const { registry, service } = make();
    registry.register({
      subject: 'Note',
      assertCanWatch: () => Promise.reject(new ForbiddenException()),
    });
    const subscribe = vi.spyOn(service, 'subscribe');
    await expect(
      service.watch(user, { subject: 'Note', recordId: 'n1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('subscribes once the target lets the principal', async () => {
    const { registry, service } = make();
    registry.register({ subject: 'Note', assertCanWatch: async () => {} });
    const subscribe = vi
      .spyOn(service, 'subscribe')
      .mockResolvedValue(undefined);
    await service.watch(user, { subject: 'Note', recordId: 'n1' });
    expect(subscribe).toHaveBeenCalledWith(user, {
      subject: 'Note',
      recordId: 'n1',
    });
  });

  it('refuses a subject no feature registered: a programming error', async () => {
    const { service } = make();
    await expect(
      service.watch(user, { subject: 'Invoice', recordId: 'i1' }),
    ).rejects.toThrow(/No SubscriptionTarget for "Invoice"/);
  });
});
