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
    expect(mail.recentFailures[1].reason).toBeUndefined();
  });
});
