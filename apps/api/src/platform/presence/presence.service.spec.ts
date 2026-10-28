import { NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { PeopleService } from '../people/people.service.js';
import type { Realtime } from '../realtime/realtime.service.js';
import type { SubscriptionsRegistry } from '../subscriptions/subscriptions.registry.js';
import { PRESENCE_TTL_SECONDS } from './presence.schemas.js';
import { PresenceService } from './presence.service.js';

const T1 = '0199a000-0000-7000-8000-00000000000a';
const T2 = '0199a000-0000-7000-8000-00000000000b';
const RECORD = {
  subject: 'Note',
  recordId: '0199a000-0000-7000-8000-0000000000c1',
};

const person = (id: string) => ({ kind: 'user', id }) as Principal;
const ada = person('ada');
const bob = person('bob');

/** The few Redis hash commands presence uses, in memory. */
function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const redis = {
    status: 'ready',
    hget: (key: string, field: string) =>
      Promise.resolve(hashes.get(key)?.[field] ?? null),
    hgetall: (key: string) => Promise.resolve({ ...hashes.get(key) }),
    hdel: (key: string, ...fields: string[]) => {
      for (const field of fields) delete hashes.get(key)?.[field];
      return Promise.resolve(fields.length);
    },
    multi: () => {
      const ops: (() => void)[] = [];
      const chain = {
        hset: (key: string, field: string, value: string) => {
          ops.push(() =>
            hashes.set(key, { ...hashes.get(key), [field]: value }),
          );
          return chain;
        },
        expire: () => chain,
        exec: () => {
          ops.forEach((op) => op());
          return Promise.resolve([]);
        },
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, hashes };
}

function serviceOf(readers: Set<string>) {
  const { redis, hashes } = fakeRedis();
  const pushed: string[] = [];
  const targets = {
    find: (subject: string) =>
      subject === 'Note'
        ? {
            subject,
            assertCanWatch: (who: Principal) =>
              readers.has(who.id)
                ? Promise.resolve()
                : Promise.reject(new NotFoundException()),
          }
        : undefined,
  } as unknown as SubscriptionsRegistry;
  const people = {
    principal: (key: string) => Promise.resolve(person(key.split(':')[1]!)),
    names: (keys: string[]) =>
      Promise.resolve(new Map([...keys].map((k) => [k, k.split(':')[1]!]))),
  } as unknown as PeopleService;
  const realtime = {
    toPrincipal: (who: Principal) => pushed.push(who.id),
  } as unknown as Realtime;
  return {
    service: new PresenceService(redis, targets, people, realtime),
    hashes,
    pushed,
  };
}

const inT1 = <T>(work: () => Promise<T>) => inTenantOf({ tenantId: T1 }, work);

describe('record presence', () => {
  it('lists who is on the record, with their mode, and tells the others once', async () => {
    const { service, pushed } = serviceOf(new Set(['ada', 'bob']));
    await inT1(async () => {
      await service.beat(ada, RECORD, 'viewing');
      const seen = await service.beat(bob, RECORD, 'editing');
      expect(seen.items).toEqual(
        expect.arrayContaining([
          { key: 'user:ada', name: 'ada', mode: 'viewing', self: false },
          { key: 'user:bob', name: 'bob', mode: 'editing', self: true },
        ]),
      );
      // Ada's first beat told her, Bob's arrival told both; a repeated beat tells nobody.
      const told = pushed.length;
      await service.beat(bob, RECORD, 'editing');
      expect(pushed).toHaveLength(told);
      await service.beat(bob, RECORD, 'viewing');
      expect(pushed.length).toBeGreaterThan(told);
    });
  });

  it('forgets whoever left, and whoever stopped beating', async () => {
    const { service, hashes } = serviceOf(new Set(['ada', 'bob']));
    await inT1(async () => {
      await service.beat(ada, RECORD, 'viewing');
      await service.beat(bob, RECORD, 'viewing');
      await service.leave(bob, RECORD);
      expect((await service.list(ada, RECORD)).items.map((i) => i.key)).toEqual(
        ['user:ada'],
      );
      // An entry past its time is gone without anyone leaving.
      const [key] = [...hashes.keys()];
      hashes.set(key!, {
        ...hashes.get(key!),
        'user:bob': `viewing:${Date.now() - 1000}`,
      });
      expect((await service.list(ada, RECORD)).items.map((i) => i.key)).toEqual(
        ['user:ada'],
      );
    });
  });

  it('shows nothing to, and takes nothing from, someone who may not read the record', async () => {
    const readers = new Set(['ada', 'bob']);
    const { service } = serviceOf(readers);
    await inT1(async () => {
      await service.beat(ada, RECORD, 'editing');
      await service.beat(bob, RECORD, 'viewing');
      // Access revoked: Bob is out of Ada's list at once, and can neither see nor announce.
      readers.delete('bob');
      expect((await service.list(ada, RECORD)).items.map((i) => i.key)).toEqual(
        ['user:ada'],
      );
      await expect(service.list(bob, RECORD)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.beat(bob, RECORD, 'viewing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // A subject nobody can watch has no presence.
      await expect(
        service.list(ada, { ...RECORD, subject: 'Other' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('keeps tenants apart and expires entries by themselves', async () => {
    const { service, hashes } = serviceOf(new Set(['ada']));
    await inT1(() => service.beat(ada, RECORD, 'viewing'));
    const [key] = [...hashes.keys()];
    expect(key).toContain(`tenant:${T1}:`);
    expect(PRESENCE_TTL_SECONDS).toBeGreaterThan(0);
    // The same record id in another tenant is a different room.
    const other = await inTenantOf({ tenantId: T2 }, () =>
      service.list(ada, RECORD),
    );
    expect(other.items).toEqual([]);
  });

  it('does without Redis', async () => {
    const { service, hashes } = serviceOf(new Set(['ada']));
    (service as unknown as { redis: { status: string } }).redis.status = 'end';
    await inT1(async () => {
      expect((await service.beat(ada, RECORD, 'viewing')).items).toEqual([]);
    });
    expect(hashes.size).toBe(0);
  });
});
