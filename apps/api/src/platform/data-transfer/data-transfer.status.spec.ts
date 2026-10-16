import { NotFoundException } from '@nestjs/common';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import type { Principal } from '../../iam/auth/principal.js';
import { DataTransferService } from './data-transfer.service.js';

const tenant = '00000000-0000-4000-8000-00000000000a';
const other = '00000000-0000-4000-8000-00000000000b';
const owner = { kind: 'client', id: 'c1', tenantId: tenant } as Principal;
const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
  inTenantOf({ tenantId }, work);
const reason = 'Unknown columns: custom.nope. Check the template.';

/** A job as BullMQ hands it out: read while it ran, or after it failed. */
const job = (failedReason?: string, tenantId = tenant) => ({
  id: 't1',
  data: {
    kind: 'import',
    name: 'notes',
    format: 'csv',
    principal: owner,
    tenantId,
  },
  progress: { processed: 1 },
  failedReason,
  returnvalue: undefined,
  getState: async () => 'failed',
});

/** The service with only its queue: status() needs nothing else on a failure. */
function service(...reads: ReturnType<typeof job>[]) {
  const getJob = vi.fn(async () => reads.shift());
  // status() uses only the queue: the other dependencies stay unset.
  const transfers = Reflect.construct(DataTransferService, [
    { getJob },
  ]) as DataTransferService;
  return { transfers, getJob };
}

describe('DataTransferService.status', () => {
  it('reads a job again when it failed between the two reads, so its reason is kept', async () => {
    // The first read happened while the job ran (no reason yet); by the
    // state read it had failed: the answer must carry the reason.
    const { transfers, getJob } = service(job(), job(reason));
    const status = await inTenant(tenant, () => transfers.status(owner, 't1'));
    expect(status).toMatchObject({ status: 'failed', error: reason });
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('reads a failed job once when its reason is there', async () => {
    const { transfers, getJob } = service(job(reason));
    await expect(
      inTenant(tenant, () => transfers.status(owner, 't1')),
    ).resolves.toMatchObject({ error: reason });
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for another tenant's transfer, even the same principal's", async () => {
    const { transfers } = service(job(reason, other));
    await expect(
      inTenant(tenant, () => transfers.status(owner, 't1')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
