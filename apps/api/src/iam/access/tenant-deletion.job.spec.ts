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
});
