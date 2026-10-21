import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { quotaExceeded, quotaOverride, TenantQuotas } from './tenant-quotas.js';

/** A database that answers one tenants row (its `quotas`) and records the SQL it executes. */
const fakeDb = (quotas: object) => {
  const executed: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ quotas }] }) }),
    execute: async (query: unknown) => {
      executed.push(query);
    },
  };
  return { db: db as never, executed };
};

describe('tenant quotas', () => {
  it('reads a tenant’s own limits', () => {
    const quotas = {
      maxMembers: 3,
      maxApiClients: 1,
      maxStorageBytes: 10,
      maxRecords: { Note: 7 },
    };
    expect(quotaOverride(quotas, 'members')).toBe(3);
    expect(quotaOverride(quotas, 'apiClients')).toBe(1);
    expect(quotaOverride(quotas, 'storageBytes')).toBe(10);
    expect(quotaOverride(quotas, 'records:Note')).toBe(7);
    expect(quotaOverride(quotas, 'records:Invoice')).toBeUndefined();
  });

  it('answers 422 quota_exceeded with the limit', () => {
    const error = quotaExceeded('records:Note', 5, 5);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({
      code: 'quota_exceeded',
      quota: { resource: 'records:Note', limit: 5, used: 5 },
    });
  });

  describe('assertRoom', () => {
    const service = () => new TenantQuotas({} as never);

    it('lets everything through without a limit, and takes no lock', async () => {
      const quotas = service();
      const count = vi.fn(async () => 99);
      quotas.count('members', count);
      const { db, executed } = fakeDb({});
      await quotas.assertRoom(db, 't1', 'members');
      expect(count).not.toHaveBeenCalled();
      expect(executed).toHaveLength(0);
    });

    it('allows up to the limit and refuses past it, under the lock', async () => {
      const quotas = service();
      let used = 1;
      quotas.count('members', async () => used);
      const { db, executed } = fakeDb({ maxMembers: 2 });
      await quotas.assertRoom(db, 't1', 'members');
      expect(executed).toHaveLength(1);
      used = 2;
      await expect(
        quotas.assertRoom(db, 't1', 'members'),
      ).rejects.toMatchObject({
        status: 422,
      });
    });

    it('counts what is added: bytes of an upload', async () => {
      const quotas = service();
      quotas.count('storageBytes', async () => 90);
      const { db } = fakeDb({ maxStorageBytes: 100 });
      await quotas.assertRoom(db, 't1', 'storageBytes', 10);
      await expect(
        quotas.assertRoom(db, 't1', 'storageBytes', 11),
      ).rejects.toMatchObject({ status: 422 });
    });

    it('falls back to the deployment default, under the tenant’s own', async () => {
      const quotas = service();
      quotas.count('apiClients', async () => 3);
      quotas.defaults(async () => 3);
      const { db } = fakeDb({});
      await expect(quotas.assertRoom(db, 't1', 'apiClients')).rejects.toThrow();
      const own = fakeDb({ maxApiClients: 10 });
      await quotas.assertRoom(own.db, 't1', 'apiClients');
    });
  });
});
