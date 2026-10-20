import type { TransactionHost } from '@nestjs-cls/transactional';
import { TenantRunsFailed } from '../../core/tenancy/tenancy.service.js';
import type { Tenant } from '../../core/tenancy/tenancy.tables.js';
import type { AuditService } from '../audit/audit.service.js';
import { SignUpTenantSweepJob } from './sign-up-tenant-sweep.job.js';
import type { SystemContext } from './system-context.js';
import type { TenantsService } from './tenants.service.js';

const tenant = (id: string) => ({ id, slug: `slug-${id}` }) as Tenant;

/** The job over stubbed candidates and a stubbed per-tenant sweep. */
function job(candidates: Tenant[], sweep: (id: string) => Promise<boolean>) {
  const system = {
    run: (_job: unknown, work: (principal: unknown) => Promise<unknown>) =>
      work({ kind: 'system' }),
  } as unknown as SystemContext;
  const instance = new SignUpTenantSweepJob(
    system,
    {} as TenantsService,
    {} as AuditService,
    {} as TransactionHost<never>,
  );
  const internals = instance as unknown as {
    candidates: () => Promise<Tenant[]>;
    sweep: (system: unknown, id: string) => Promise<boolean>;
  };
  internals.candidates = async () => candidates;
  const swept = vi.fn((_system: unknown, id: string) => sweep(id));
  internals.sweep = swept;
  return { instance, swept };
}

describe('SignUpTenantSweepJob', () => {
  it('goes on past a tenant that fails, then reports the failures together', async () => {
    const { instance, swept } = job(
      [tenant('a'), tenant('b'), tenant('c')],
      async (id) => {
        if (id === 'b') {
          throw new Error('deadlock');
        }
        return true;
      },
    );
    const run = instance.sweepAll();
    await expect(run).rejects.toBeInstanceOf(TenantRunsFailed);
    await run.catch((error: TenantRunsFailed) => {
      expect(error.failures.map(({ tenant }) => tenant.id)).toEqual(['b']);
      expect(error.message).toContain('slug-b (deadlock)');
    });
    // Every candidate was tried: c after b failed.
    expect(swept.mock.calls.map(([, id]) => id)).toEqual(['a', 'b', 'c']);
  });

  it('counts the tenants deleted when none fails', async () => {
    const { instance } = job(
      [tenant('a'), tenant('b')],
      async (id) => id === 'a',
    );
    await expect(instance.sweepAll()).resolves.toBe(1);
  });
});
