import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import { DataTransferService } from './data-transfer.service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const principal = {
  kind: 'client',
  id: 'client-1',
  tenantId,
  name: 'client',
} as RequestPrincipal;

describe('DataTransferService import limit snapshots', () => {
  it('stores the resolved limits in the accepted queue job', async () => {
    const add = vi.fn(async (_kind: string, _job: unknown) => ({
      id: 'job-1',
    }));
    const transfers = Reflect.construct(DataTransferService, [
      { add },
      { importer: () => ({ name: 'notes', subject: 'Note', schema: {} }) },
      { can: async () => true },
      { record: async () => undefined },
      {},
      {},
      {},
      {},
      { add: async () => undefined },
      {},
    ]) as DataTransferService;
    const limits = { maxBytes: 75 * 1024 * 1024, maxRows: 2_000_000 };

    await inTenantOf({ tenantId }, () =>
      transfers.startImport(principal, {
        name: 'notes',
        key: `tenants/${tenantId}/transfers/uploads/u1`,
        format: 'csv',
        dryRun: false,
        limits,
      }),
    );

    const data = add.mock.calls[0]![1] as {
      principal: Principal;
      limits: typeof limits;
    };
    expect(data.principal).toEqual(principal);
    expect(data.limits).toEqual(limits);
  });
});
