import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';
import { tenantKey } from '../../core/tenancy/tenant-scope.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';

/**
 * How long an entry stays: a day past the 7 days BullMQ keeps a finished
 * transfer or bulk run (`removeOnComplete` / `removeOnFail`), so an entry
 * never outlives its job by much and never dies before it.
 */
export const JOB_INDEX_TTL_MS = 8 * 24 * 3600 * 1000;

/** The rounds a page reads at most to step over entries whose job is gone. */
const MAX_ROUNDS = 5;

/** A page of jobs, as `GET /v1/data/transfers` and `GET /v1/bulk` answer it. */
export interface JobPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Which jobs a principal queued in a tenant, newest first: a Redis sorted
 * set per list, `tenant:<tid>:jobs:<list>:<principal key>`, scored by the
 * time the job was queued.
 *
 * Custom code, because nothing offers it: BullMQ keeps a job by its id and
 * lists a queue by state only, across every tenant and principal (no index
 * on the job's data), and the jobs themselves live in Redis, not in a
 * table the list helpers (`listQuery`, `toPage`) could page. The entries
 * expire with their jobs (JOB_INDEX_TTL_MS), so nothing has to sweep them.
 *
 * The tenant and the principal are in the key (docs/tenancy.md,
 * "Per-principal keys carry the tenant"); a reader still checks each job's
 * own `tenantId` and principal, as the single routes do. A job queued in no
 * tenant (a user's account export: the person's, across their tenants) is
 * listed under the account instead, `account:jobs:<list>:<principal key>`
 * (`tenantId` null).
 */
@Injectable()
export class JobIndex {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(list: string, tenantId: string | null, principal: Principal) {
    const key = `jobs:${list}:${principalKey(principal)}`;
    return tenantId === null ? `account:${key}` : tenantKey(key, tenantId);
  }

  /**
   * Notes a job in these lists (`data-transfers`, `data-transfers:export`),
   * before it is queued: an entry whose job never came is skipped by
   * `page()`, while a job without its entry would be missing from the list.
   */
  async add(
    lists: readonly string[],
    tenantId: string | null,
    principal: Principal,
    id: string,
    // Below the millisecond (a double holds it): two jobs queued in the same
    // millisecond keep their order instead of their ids' (random) one.
    at = performance.timeOrigin + performance.now(),
  ) {
    const multi = this.redis.multi();
    for (const list of lists) {
      const key = this.key(list, tenantId, principal);
      multi
        .zadd(key, at, id)
        .zremrangebyscore(key, '-inf', at - JOB_INDEX_TTL_MS)
        .pexpire(key, JOB_INDEX_TTL_MS);
    }
    const results = await multi.exec();
    const failed = results?.find(([error]) => error)?.[0];
    if (failed) {
      throw failed;
    }
  }

  /** The rank a page after `cursor` starts at; a 400 for an unknown cursor. */
  private async startAfter(key: string, cursor: string) {
    const rank = await this.redis.zrevrank(key, cursor);
    if (rank === null) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The cursor is unknown or expired: start from the first page.',
        errors: [{ path: 'cursor', message: 'Unknown or expired.' }],
      });
    }
    return rank + 1;
  }

  /**
   * A page of the principal's jobs in a list, newest first, after `cursor`
   * (the last id of the previous page, as every cursor list takes it).
   * `read` turns an id into the item, or null when its job is gone (or is
   * not this principal's in this tenant): such an entry is removed and
   * skipped. An unknown cursor (its entry expired) is a 400.
   *
   * `accept` keeps only some of the jobs (a `?status=` filter): one it
   * refuses is skipped but stays in the index and counts as read, so the
   * cursor steps over it. A filtered page may then hold fewer than `limit`
   * items, even none, while `nextCursor` says there is more to read (a
   * page reads at most MAX_ROUNDS rounds of entries).
   */
  async page<T extends { id: string }>(
    list: string,
    tenantId: string | null,
    principal: Principal,
    { limit, cursor }: { limit: number; cursor?: string },
    read: (id: string) => Promise<T | null>,
    accept: (item: T) => boolean = () => true,
  ): Promise<JobPage<T>> {
    const key = this.key(list, tenantId, principal);
    const items: T[] = [];
    let after = cursor;
    let ended = false;
    // The last entry read whose job still exists: where the next round (or page) starts.
    let lastRead: string | undefined;
    // One more than the page: whether there is a next page.
    for (let round = 0; round < MAX_ROUNDS && items.length <= limit; round++) {
      const start = after === undefined ? 0 : await this.startAfter(key, after);
      const wanted = limit + 1 - items.length;
      const ids = await this.redis.zrevrange(key, start, start + wanted - 1);
      const found: (T | null)[] = await Promise.all(ids.map((id) => read(id)));
      const gone = ids.filter((_, index) => found[index] === null);
      if (gone.length) {
        await this.redis.zrem(key, ...gone);
      }
      lastRead = ids.findLast((_, index) => found[index] !== null) ?? lastRead;
      items.push(
        ...found.filter((item): item is T => item !== null && accept(item)),
      );
      if (ids.length < wanted) {
        ended = true;
        break;
      }
      // The next round starts after the last one read (the gone are removed).
      after = lastRead ?? after;
    }
    const page = items.slice(0, limit);
    // A full page continues after its last item (the next one is re-read);
    // a short one, cut off by MAX_ROUNDS, after the last entry read.
    const nextCursor =
      items.length > limit
        ? page.at(-1)!.id
        : ended
          ? null
          : (lastRead ?? null);
    return { items: page, nextCursor };
  }
}
