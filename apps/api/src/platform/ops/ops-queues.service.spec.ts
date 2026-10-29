import type { ModuleRef } from '@nestjs/core';
import { REDACTED } from '../../core/logging/redaction.js';
import type { PlatformOptions } from '../platform.options.js';
import { OpsQueues } from './ops-queues.service.js';

describe('OpsQueues', () => {
  it("masks a credential in a failed job's reason", async () => {
    const token = `tok-${Date.now()}-abcdefgh`;
    const queue = {
      getJobCounts: async () => ({ failed: 1 }),
      isPaused: async () => false,
      getFailed: async () => [
        {
          id: '1',
          name: 'send',
          attemptsMade: 3,
          failedReason: `Request failed: Authorization: Bearer ${token}`,
          finishedOn: 0,
        },
        { id: '2', name: 'send', attemptsMade: 1, failedReason: undefined },
      ],
    };
    const moduleRef = { get: () => queue } as unknown as ModuleRef;
    const [mail] = await new OpsQueues(
      {} as PlatformOptions,
      moduleRef,
    ).overview();
    expect(mail.recentFailures[0].reason).toBe(
      `Request failed: Authorization: Bearer ${REDACTED}`,
    );
    expect(mail.recentFailures[1].reason).toBeNull();
  });
  it('reads the oldest waiting job’s age per queue, 0 when none waits', async () => {
    const getJobs = vi
      .fn()
      .mockResolvedValueOnce([{ timestamp: 1_000 }])
      .mockResolvedValue([]);
    const moduleRef = { get: () => ({ getJobs }) } as unknown as ModuleRef;
    const ages = await new OpsQueues(
      { queues: [] } as unknown as PlatformOptions,
      moduleRef,
    ).oldestWaiting(31_000);
    expect(getJobs).toHaveBeenCalledWith(['waiting'], 0, 0, true);
    expect(ages[0]).toEqual({ name: 'mail', seconds: 30 });
    expect(ages.slice(1).every((age) => age.seconds === 0)).toBe(true);
  });
});
