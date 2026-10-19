import { NotFoundException } from '@nestjs/common';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import type { Principal } from '../../iam/auth/principal.js';
import { BulkService, PRINCIPAL_GONE } from './bulk.service.js';

const tenant = '00000000-0000-4000-8000-00000000000a';
const other = '00000000-0000-4000-8000-00000000000b';
const owner = { kind: 'user', id: 'u1', tenantId: tenant } as Principal;

/** A job as BullMQ hands it out: read while it ran, or after it failed. */
const job = (failedReason?: string, tenantId = tenant) => ({
  id: 'b1',
  data: { name: 'notes', action: 'delete', principal: owner, tenantId },
  progress: { processed: 1 },
  timestamp: Date.parse('2026-10-20T10:00:00Z'),
  processedOn: Date.parse('2026-10-20T10:00:05Z'),
  finishedOn: Date.parse('2026-10-20T10:01:00Z'),
  failedReason,
  returnvalue: undefined,
  getState: async () => 'failed',
});

describe('BulkService.status', () => {
  it('reads a run again when it failed between the two reads, so its reason is kept', async () => {
    const reads = [job(), job(PRINCIPAL_GONE)];
    const getJob = vi.fn(async () => reads.shift());
    // status() uses only the queue: the other dependencies stay unset.
    const bulk = Reflect.construct(BulkService, [{ getJob }]) as BulkService;
    await expect(
      inTenantOf({ tenantId: tenant }, () => bulk.status(owner, 'b1')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: PRINCIPAL_GONE,
      createdAt: '2026-10-20T10:00:00.000Z',
      startedAt: '2026-10-20T10:00:05.000Z',
      finishedAt: '2026-10-20T10:01:00.000Z',
    });
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it("answers 404 for another tenant's run, even the same principal's", async () => {
    const getJob = vi.fn(async () => job(PRINCIPAL_GONE, other));
    const bulk = Reflect.construct(BulkService, [{ getJob }]) as BulkService;
    await expect(
      inTenantOf({ tenantId: tenant }, () => bulk.status(owner, 'b1')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
