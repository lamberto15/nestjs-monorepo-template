import { BadRequestException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Principal } from '../../iam/auth/principal.js';
import { JOB_INDEX_TTL_MS, JobIndex } from './job-index.js';

const tenant = '00000000-0000-4000-8000-00000000000a';
const other = '00000000-0000-4000-8000-00000000000b';
const alice = { kind: 'user', id: 'alice', tenantId: tenant } as Principal;
const bob = { kind: 'user', id: 'bob', tenantId: tenant } as Principal;

/**
 * The sorted-set commands JobIndex uses, in memory: members ordered by
 * score, then by member, as Redis orders them (reversed for zrev*).
 */
function fakeRedis() {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  const reversed = (key: string) =>
    [...set(key)]
      .sort(([a, sa], [b, sb]) => sb - sa || (a < b ? 1 : a > b ? -1 : 0))
      .map(([member]) => member);
  const commands = {
    zadd: (key: string, score: number, member: string) => {
      set(key).set(member, score);
    },
    zremrangebyscore: (key: string, _min: string, max: number) => {
      for (const [member, score] of set(key)) {
        if (score <= max) set(key).delete(member);
      }
    },
    pexpire: () => undefined,
  };
  const redis = {
    sets,
    multi() {
      const queued: (() => void)[] = [];
      const chain = {
        zadd: (...args: Parameters<typeof commands.zadd>) => {
          queued.push(() => commands.zadd(...args));
          return chain;
        },
        zremrangebyscore: (
          ...args: Parameters<typeof commands.zremrangebyscore>
        ) => {
          queued.push(() => commands.zremrangebyscore(...args));
          return chain;
        },
        pexpire: () => chain,
        exec: async () => queued.map((run) => [null, run()]),
      };
      return chain;
    },
    zrevrank: async (key: string, member: string) => {
      const rank = reversed(key).indexOf(member);
      return rank < 0 ? null : rank;
    },
    zrevrange: async (key: string, start: number, stop: number) =>
      reversed(key).slice(start, stop + 1),
    zrem: async (key: string, ...members: string[]) => {
      members.forEach((member) => set(key).delete(member));
    },
  };
  return redis;
}

const ids = (page: { items: { id: string }[] }) =>
  page.items.map((item) => item.id);

describe('JobIndex', () => {
  const setup = () => {
    const redis = fakeRedis();
    const index = new JobIndex(redis as unknown as Redis);
    return { redis, index };
  };
  const found = async (id: string) => ({ id });

  it('pages a principal’s jobs newest first, the cursor being the last id', async () => {
    const { index } = setup();
    for (let n = 1; n <= 5; n++) {
      await index.add(['list'], tenant, alice, `job-${n}`, 1000 + n);
    }
    const first = await index.page('list', tenant, alice, { limit: 2 }, found);
    expect(ids(first)).toEqual(['job-5', 'job-4']);
    expect(first.nextCursor).toBe('job-4');
    const second = await index.page(
      'list',
      tenant,
      alice,
      { limit: 2, cursor: first.nextCursor! },
      found,
    );
    expect(ids(second)).toEqual(['job-3', 'job-2']);
    const last = await index.page(
      'list',
      tenant,
      alice,
      { limit: 2, cursor: second.nextCursor! },
      found,
    );
    expect(last).toEqual({ items: [{ id: 'job-1' }], nextCursor: null });
  });

  it('keeps principals and tenants apart', async () => {
    const { index } = setup();
    await index.add(['list'], tenant, alice, 'alice-job');
    await index.add(['list'], tenant, bob, 'bob-job');
    await index.add(['list'], other, alice, 'alice-elsewhere');
    expect(
      ids(await index.page('list', tenant, alice, { limit: 10 }, found)),
    ).toEqual(['alice-job']);
    expect(
      ids(await index.page('list', tenant, bob, { limit: 10 }, found)),
    ).toEqual(['bob-job']);
    expect(
      ids(await index.page('list', other, alice, { limit: 10 }, found)),
    ).toEqual(['alice-elsewhere']);
    // Another principal's id is no cursor here.
    await expect(
      index.page(
        'list',
        tenant,
        alice,
        { limit: 10, cursor: 'bob-job' },
        found,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('skips and removes entries whose job is gone, still filling the page', async () => {
    const { redis, index } = setup();
    for (let n = 1; n <= 6; n++) {
      await index.add(['list'], tenant, alice, `job-${n}`, 1000 + n);
    }
    const gone = new Set(['job-6', 'job-5', 'job-3']);
    const read = async (id: string) => (gone.has(id) ? null : { id });
    const page = await index.page('list', tenant, alice, { limit: 2 }, read);
    expect(ids(page)).toEqual(['job-4', 'job-2']);
    expect(page.nextCursor).toBe('job-2');
    const [members] = [...redis.sets.values()];
    expect([...members!.keys()].sort()).toEqual(['job-1', 'job-2', 'job-4']);
  });

  it('drops entries older than their jobs when it adds one', async () => {
    const { redis, index } = setup();
    const now = 10 * JOB_INDEX_TTL_MS;
    await index.add(['list'], tenant, alice, 'old', now - JOB_INDEX_TTL_MS - 1);
    await index.add(['list', 'list:export'], tenant, alice, 'new', now);
    expect(
      ids(await index.page('list', tenant, alice, { limit: 10 }, found)),
    ).toEqual(['new']);
    expect(
      ids(await index.page('list:export', tenant, alice, { limit: 10 }, found)),
    ).toEqual(['new']);
    expect(redis.sets.size).toBe(2);
  });
});
