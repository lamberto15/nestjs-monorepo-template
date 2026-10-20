import type { TransactionHost } from '@nestjs-cls/transactional';
import {
  type Tenancy,
  TenantRunsFailed,
} from '../../core/tenancy/tenancy.service.js';
import type { Tenant } from '../../core/tenancy/tenancy.tables.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ApiClientLifecycleRegistry } from './api-client-lifecycle.registry.js';
import type { SystemContext } from './system-context.js';
import { TenantDeletionJob } from './tenant-deletion.job.js';
import { TenantLifecycleRegistry } from './tenant-lifecycle.registry.js';
import type { TenantsService } from './tenants.service.js';

const tenant = (id: string) => ({ id, slug: `slug-${id}` }) as Tenant;

/** The job over stubbed due tenants and a stubbed per-tenant erase. */
function job(due: Tenant[], erase: (id: string) => Promise<boolean>) {
  const system = {
    run: (_job: unknown, work: (principal: unknown) => Promise<unknown>) =>
      work({ kind: 'system' }),
  } as unknown as SystemContext;
  const instance = new TenantDeletionJob(
    system,
    {} as TenantsService,
    {} as Tenancy,
    {} as AuditService,
    new TenantLifecycleRegistry(),
    {} as ApiClientLifecycleRegistry,
    {} as TransactionHost<never>,
  );
  const internals = instance as unknown as {
    due: () => Promise<Tenant[]>;
    erase: (system: unknown, tenant: Tenant, now: Date) => Promise<boolean>;
  };
  internals.due = async () => due;
  const erased = vi.fn((_system: unknown, t: Tenant) => erase(t.id));
  internals.erase = erased;
  return { instance, erased };
}

describe('TenantDeletionJob', () => {
  it('goes on past a tenant that fails, then reports the failures together', async () => {
    const { instance, erased } = job(
      [tenant('a'), tenant('b'), tenant('c')],
      async (id) => {
        if (id === 'b') {
          throw new Error('storage unavailable');
        }
        return true;
      },
    );
    const run = instance.eraseDue();
    await expect(run).rejects.toBeInstanceOf(TenantRunsFailed);
    await run.catch((error: TenantRunsFailed) => {
      expect(error.failures.map(({ tenant: t }) => t.id)).toEqual(['b']);
      expect(error.message).toContain('slug-b (storage unavailable)');
    });
    expect(erased.mock.calls.map(([, t]) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts the tenants erased (a cancelled one is skipped)', async () => {
    const { instance } = job(
      [tenant('a'), tenant('b')],
      async (id) => id === 'a',
    );
    await expect(instance.eraseDue()).resolves.toBe(1);
  });

  it("keeps the tenant while its clients' cleanup fails, and erases it once a later night's succeeds", async () => {
    const due = {
      ...tenant('a'),
      deletionRequestedAt: null,
      deletionScheduledFor: null,
    } as Tenant;
    // The claim's UPDATE … RETURNING: the tenant, every night.
    const chain = {
      update: () => chain,
      set: () => chain,
      where: () => chain,
      returning: async () => [due],
    };
    const txHost = {
      withTransaction: (work: () => Promise<unknown>) => work(),
      tx: chain,
    } as unknown as TransactionHost<never>;
    const deleteRow = vi.fn(async () => due);
    const tenants = {
      principalsOf: async () => [
        { kind: 'user', id: 'u1' },
        { kind: 'client', id: 'c1' },
      ],
      deleteRow,
    } as unknown as TenantsService;
    const tenancy = {
      run: (_id: string, work: () => Promise<unknown>) => work(),
    } as unknown as Tenancy;
    const afterDeletion = vi
      .fn()
      .mockRejectedValueOnce(new Error('webhooks store unavailable'))
      .mockResolvedValue(undefined);
    const clientLifecycle = {
      all: () => [{ name: 'webhooks', afterDeletion }],
    } as unknown as ApiClientLifecycleRegistry;
    const system = {
      run: (_job: unknown, work: (principal: unknown) => Promise<unknown>) =>
        work({ kind: 'system' }),
    } as unknown as SystemContext;
    const instance = new TenantDeletionJob(
      system,
      tenants,
      tenancy,
      { record: vi.fn() } as unknown as AuditService,
      new TenantLifecycleRegistry(),
      clientLifecycle,
      txHost,
    );
    (instance as unknown as { due: () => Promise<Tenant[]> }).due =
      async () => [due];

    await expect(instance.eraseDue()).rejects.toBeInstanceOf(TenantRunsFailed);
    // The row stays: the next night tries again.
    expect(deleteRow).not.toHaveBeenCalled();
    expect(afterDeletion).toHaveBeenCalledWith('c1', 'a');

    await expect(instance.eraseDue()).resolves.toBe(1);
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(afterDeletion).toHaveBeenCalledTimes(2);
  });
});
