import type { Transaction } from '../../core/database/drizzle.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { PeopleService } from '../people/people.service.js';
import {
  BULK_THRESHOLD,
  type NotificationCatalog,
} from './notification-catalog.js';
import {
  type NotifyInput,
  NotificationsService,
} from './notifications.service.js';

// The tenant context needs nestjs-cls; notifyMany's logic does not.
vi.mock(import('../../core/tenancy/tenant-scope.js'), async (original) => ({
  ...(await original()),
  currentTenantId: () => 't1',
}));

describe('NotificationsService.notifyMany bulk summaries (#618)', () => {
  /** A transaction that records the rows stored, with `old` as the rows collapsed away. */
  function setup(old: Record<string, unknown>[] = []) {
    const stored: Record<string, unknown>[] = [];
    const tx = {
      execute: async () => undefined,
      delete: () => ({ where: () => ({ returning: async () => old }) }),
      insert: () => ({
        values: (values: Record<string, unknown>[]) => ({
          returning: async () => {
            stored.push(...values);
            return values.map((_, index) => ({ id: `id-${index}` }));
          },
        }),
      }),
    } as unknown as Transaction;
    const outbox = { add: vi.fn(async () => undefined) };
    const people = {
      principal: async (key: string) =>
        key === 'user:gone'
          ? null
          : ({ kind: 'user', id: key.slice(5) } as Principal),
    } as unknown as PeopleService;
    const service = new NotificationsService(
      undefined as never,
      {
        declaration: (type: string) =>
          type === 'note.published' ? { bulk: 'digest' } : {},
      } as unknown as NotificationCatalog,
      outbox as never,
      undefined as never,
      undefined as never,
      undefined as never,
      people,
    );
    return { service, tx, stored, outbox };
  }

  const notices = (count: number, to: string[]): NotifyInput[] =>
    Array.from({ length: count }, (_, index) => ({
      type: 'note.published',
      to,
      data: { noteId: `n${index}`, title: `Note ${index}` },
      link: `/notes/n${index}`,
    }));

  it('stores one per record up to the threshold', async () => {
    const { service, tx, stored } = setup();
    await service.notifyMany(tx, notices(BULK_THRESHOLD, ['user:a']));
    expect(stored).toHaveLength(BULK_THRESHOLD);
    expect(stored[0]).toMatchObject({ key: null, count: 1 });
  });

  it('past it, one summary per recipient of the records they may read', async () => {
    const { service, tx, stored, outbox } = setup();
    await service.notifyMany(
      tx,
      notices(BULK_THRESHOLD + 1, ['user:a', 'user:b', 'user:c', 'user:gone']),
      {
        link: '/notes?status=published',
        // b may read the first two notes, c none.
        readable: async (recipient, inputs) =>
          recipient.id === 'a'
            ? inputs
            : recipient.id === 'b'
              ? inputs.slice(0, 2)
              : [],
      },
    );
    expect(stored).toEqual([
      {
        recipient: 'user:a',
        type: 'note.published',
        data: { bulk: true, titles: ['Note 0', 'Note 1', 'Note 2'] },
        key: 'bulk:note.published',
        count: BULK_THRESHOLD + 1,
        link: '/notes?status=published',
      },
      {
        recipient: 'user:b',
        type: 'note.published',
        data: { bulk: true, titles: ['Note 0', 'Note 1'] },
        key: 'bulk:note.published',
        count: 2,
        link: '/notes?status=published',
      },
    ]);
    // One outbox message per summary: one delivery, one mail at most.
    expect(outbox.add).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        payload: expect.objectContaining({ recipient: 'user:a' }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ recipient: 'user:b' }),
      }),
    ]);
  });

  it('adds up with the unread summary it replaces, not with a read one', async () => {
    const unread = setup([
      {
        recipient: 'user:a',
        key: 'bulk:note.published',
        count: 200,
        data: { bulk: true, titles: ['First'] },
        readAt: null,
      },
    ]);
    await unread.service.notifyMany(
      unread.tx,
      notices(BULK_THRESHOLD + 1, ['user:a']),
    );
    expect(unread.stored[0]).toMatchObject({
      count: 200 + BULK_THRESHOLD + 1,
      data: { bulk: true, titles: ['First', 'Note 0', 'Note 1'] },
    });

    const read = setup([
      {
        recipient: 'user:a',
        key: 'bulk:note.published',
        count: 200,
        data: { bulk: true, titles: ['First'] },
        readAt: new Date(),
      },
    ]);
    await read.service.notifyMany(
      read.tx,
      notices(BULK_THRESHOLD + 1, ['user:a']),
    );
    expect(read.stored[0]).toMatchObject({ count: BULK_THRESHOLD + 1 });
  });

  it('never sums up a type without the bulk policy', async () => {
    const { service, tx, stored } = setup();
    await service.notifyMany(
      tx,
      notices(BULK_THRESHOLD + 1, ['user:a']).map((input) => ({
        ...input,
        type: 'note.changed' as const,
      })),
    );
    expect(stored).toHaveLength(BULK_THRESHOLD + 1);
  });
});
