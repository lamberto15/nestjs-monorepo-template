import type { Principal } from '../../iam/auth/principal.js';
import { BulkService, PRINCIPAL_GONE } from './bulk.service.js';

const owner = { kind: 'user', id: 'u1' } as Principal;

/** A job as BullMQ hands it out: read while it ran, or after it failed. */
const job = (failedReason?: string) => ({
  id: 'b1',
  data: { name: 'notes', action: 'delete', principal: owner },
  progress: { processed: 1 },
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
    await expect(bulk.status(owner, 'b1')).resolves.toMatchObject({
      status: 'failed',
      error: PRINCIPAL_GONE,
    });
    expect(getJob).toHaveBeenCalledTimes(2);
  });
});
