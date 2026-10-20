import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SsoPolicyService } from './sso-policy.service.js';
import { SsoRequiredGuard } from './sso-required.guard.js';

vi.mock('@nestjs/i18n', async (original) => ({
  ...(await original<typeof import('@nestjs/i18n')>()),
  t: (key: string) => key,
}));

const user = {
  kind: 'user' as const,
  id: 'u1',
  email: 'a@example.com',
  name: 'A',
  emailVerified: true,
  locale: null,
  timezone: null,
  tenantId: 't1',
};

function context(request: Record<string, unknown>) {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SsoRequiredGuard', () => {
  const allows = vi.fn();
  const guard = new SsoRequiredGuard(new Reflector(), {
    allows,
  } as unknown as SsoPolicyService);

  beforeEach(() => allows.mockReset());

  it('lets through what SSO required does not cover', async () => {
    for (const principal of [
      undefined,
      { kind: 'client', id: 'c1', name: 'c', tenantId: 't1' },
      { ...user, impersonator: { id: 'admin', email: 'x@example.com' } },
      { ...user, tenantId: null },
    ]) {
      await expect(
        guard.canActivate(context({ user: principal })),
      ).resolves.toBe(true);
    }
    expect(allows).not.toHaveBeenCalled();
  });

  it("asks the tenant's policy with the session's authentication", async () => {
    allows.mockResolvedValue('sso');
    const session = {
      userId: 'u1',
      createdAt: new Date(),
      metadata: { method: 'sso', provider: 'conn-1' },
    };
    await expect(guard.canActivate(context({ user, session }))).resolves.toBe(
      true,
    );
    expect(allows).toHaveBeenCalledWith(
      't1',
      'u1',
      expect.objectContaining({ method: 'sso', provider: 'conn-1' }),
    );
  });

  it('answers 403 sso_required when the policy says no', async () => {
    allows.mockResolvedValue(false);
    await expect(
      guard.canActivate(context({ user, session: null })),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'sso_required' },
    });
  });
});
