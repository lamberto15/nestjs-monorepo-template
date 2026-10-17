import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import { systemPrincipal } from '../../iam/auth/principal.js';
import { stillActive } from './still-active.js';

describe('stillActive', () => {
  it('never takes a system principal read from a payload: no one, without a query', async () => {
    const payload = JSON.parse(
      JSON.stringify(systemPrincipal({ key: 'seed', label: 'Seed' })),
    );
    const untouched = new Proxy({} as never, {
      get: () => {
        throw new Error('queried');
      },
    });
    expect(await stillActive(payload, untouched, untouched)).toBeNull();
  });

  it('never runs a payload whose principal acted in another tenant: no one, without a query', async () => {
    const untouched = new Proxy({} as never, {
      get: () => {
        throw new Error('queried');
      },
    });
    const principal = {
      kind: 'client' as const,
      id: 'c1',
      name: 'c1',
      tenantId: '00000000-0000-4000-8000-00000000000b',
    };
    await expect(
      inTenantOf({ tenantId: '00000000-0000-4000-8000-00000000000a' }, () =>
        stillActive(principal, untouched, untouched),
      ),
    ).resolves.toBeNull();
  });
});
