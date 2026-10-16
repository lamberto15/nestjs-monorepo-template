import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerStorageService,
  type ThrottlerRequest,
} from '@nestjs/throttler';
import type { CoreEnv } from '../config/core.env.js';
import { ScaledThrottlerGuard } from './scaled-throttler.guard.js';

const guardWith = (multiplier: number) =>
  new ScaledThrottlerGuard(
    { throttlers: [{ ttl: 60_000, limit: 600 }] },
    new ThrottlerStorageService(),
    new Reflector(),
    { get: () => multiplier } as unknown as ConfigService<CoreEnv, true>,
  );

const request = { limit: 5, ttl: 900_000 } as ThrottlerRequest;

describe('ScaledThrottlerGuard (RATE_LIMIT_MULTIPLIER)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes every limit unchanged by default', async () => {
    const handled = vi
      .spyOn(ThrottlerGuard.prototype as any, 'handleRequest')
      .mockResolvedValue(true);
    await (guardWith(1) as any).handleRequest(request);
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, ttl: 900_000 }),
    );
  });

  it('multiplies the resolved limit (a route’s @Throttle too), never the window', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const handled = vi
      .spyOn(ThrottlerGuard.prototype as any, 'handleRequest')
      .mockResolvedValue(true);
    await (guardWith(1000) as any).handleRequest(request);
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, ttl: 900_000 }),
    );
  });
});
