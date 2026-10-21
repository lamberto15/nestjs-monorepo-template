import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_IN_MAINTENANCE } from '../../core/http/maintenance.js';
import { ModeGuard } from './mode.guard.js';
import type { ModeService } from './mode.service.js';
import type { AppMode } from './mode.setting.js';

vi.mock(import('@nestjs/i18n'), async (importOriginal) => ({
  ...(await importOriginal()),
  t: ((key: string) => key) as never,
}));

function run(mode: AppMode, method: string, allowed = false) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
    key === ALLOW_IN_MAINTENANCE ? allowed : undefined,
  );
  const guard = new ModeGuard(reflector, {
    get: () => Promise.resolve(mode),
  } as unknown as ModeService);
  const context = {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

describe('ModeGuard', () => {
  it('lets everything through in normal mode', async () => {
    await expect(run('normal', 'POST')).resolves.toBe(true);
  });

  it('read-only: reads pass, writes answer 503 read_only with Retry-After', async () => {
    await expect(run('read-only', 'GET')).resolves.toBe(true);
    await expect(run('read-only', 'HEAD')).resolves.toBe(true);
    const refusal = await run('read-only', 'PUT').catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 503 });
    expect((refusal as { getResponse(): unknown }).getResponse()).toMatchObject(
      { code: 'read_only', retryAfter: 30 },
    );
  });

  it('maintenance: even a read answers 503 maintenance', async () => {
    const refusal = await run('maintenance', 'GET').catch((e: unknown) => e);
    expect((refusal as { getResponse(): unknown }).getResponse()).toMatchObject(
      { code: 'maintenance' },
    );
  });

  it('a route marked @AllowInMaintenance() is never refused', async () => {
    await expect(run('maintenance', 'POST', true)).resolves.toBe(true);
    await expect(run('read-only', 'POST', true)).resolves.toBe(true);
  });
});
