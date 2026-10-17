import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { MfaService } from '@nestjs/authentication';
import type { SingleTenant } from '../access/single-tenant.js';
import type { IamEnv } from '../iam.env.js';
import {
  type AuthPolicySource,
  ceilingRefusal,
  effectivePasswordMinLength,
  effectiveRequireMfa,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_LIMIT,
} from './auth-policy.js';
import { AuthPolicyService } from './auth-policy.service.js';
import type { UserPrincipal } from './principal.js';
import type { UsersRepository } from './users.repository.js';

const user = (overrides: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user',
  id: 'u1',
  email: 'ada@example.com',
  name: 'Ada',
  emailVerified: true,
  locale: null,
  timezone: null,
  tenantId: 't1',
  ...overrides,
});

describe('auth policy ceiling', () => {
  it('requires two-factor only when a tenant asks and AUTH_MFA allows enrolling', () => {
    expect(effectiveRequireMfa({ AUTH_MFA: true }, true)).toBe(true);
    expect(effectiveRequireMfa({ AUTH_MFA: true }, false)).toBe(false);
    expect(effectiveRequireMfa({ AUTH_MFA: true }, undefined)).toBe(false);
    expect(effectiveRequireMfa({ AUTH_MFA: false }, true)).toBe(false);
  });

  it('takes the strictest minimum length, between the floor and the limit', () => {
    expect(effectivePasswordMinLength([])).toBe(PASSWORD_MIN_LENGTH);
    expect(effectivePasswordMinLength([undefined])).toBe(PASSWORD_MIN_LENGTH);
    expect(effectivePasswordMinLength([16, 20, undefined])).toBe(20);
    // Never looser than the floor, never past the limit.
    expect(effectivePasswordMinLength([4])).toBe(PASSWORD_MIN_LENGTH);
    expect(effectivePasswordMinLength([500])).toBe(PASSWORD_MIN_LENGTH_LIMIT);
    expect(effectivePasswordMinLength([Number.NaN])).toBe(PASSWORD_MIN_LENGTH);
  });

  it('refuses to store requireMfa=true when AUTH_MFA is off, nothing else', () => {
    expect(ceilingRefusal({ AUTH_MFA: false }, 'requireMfa', true)).toMatch(
      /AUTH_MFA is off/,
    );
    expect(
      ceilingRefusal({ AUTH_MFA: false }, 'requireMfa', false),
    ).toBeUndefined();
    expect(
      ceilingRefusal({ AUTH_MFA: true }, 'requireMfa', true),
    ).toBeUndefined();
  });
});

describe('AuthPolicyService', () => {
  let env: { AUTH_MFA: boolean };
  let enrolled: boolean;
  let single: boolean;
  const memberships = vi.fn(async (_userId: string) => [
    { id: 't1' },
    { id: 't2' },
  ]);
  const source = {
    requireMfa: vi.fn(async (_user: UserPrincipal) => true),
    passwordMinLength: vi.fn(async (tenantId: string) =>
      tenantId === 't2' ? 20 : undefined,
    ),
  } satisfies AuthPolicySource;

  const service = (withSource: AuthPolicySource | null = source) =>
    new AuthPolicyService(
      {
        get: (key: keyof typeof env) => env[key],
      } as unknown as ConfigService<IamEnv, true>,
      { isEnrolled: async () => enrolled } as unknown as MfaService,
      { memberships } as unknown as UsersRepository,
      {
        get enabled() {
          return single;
        },
        tenant: async () => ({ id: 'only', name: 'Only' }),
      } as unknown as SingleTenant,
      withSource ?? undefined,
    );

  beforeEach(() => {
    env = { AUTH_MFA: true };
    enrolled = false;
    single = false;
    vi.clearAllMocks();
  });

  it('restricts a user who is required and not enrolled', async () => {
    expect(await service().mfaEnrollmentRequired(user())).toBe(true);
    enrolled = true;
    expect(await service().mfaEnrollmentRequired(user())).toBe(false);
  });

  it('never restricts API clients, impersonations, users without a tenant, or anyone without the port', async () => {
    const policy = service();
    expect(
      await policy.mfaEnrollmentRequired({
        kind: 'client',
        id: 'c1',
        name: 'c',
        tenantId: 't1',
      }),
    ).toBe(false);
    expect(
      await policy.mfaEnrollmentRequired(
        user({ impersonator: { id: 'a', email: 'admin@example.com' } }),
      ),
    ).toBe(false);
    expect(await policy.mfaEnrollmentRequired(user({ tenantId: null }))).toBe(
      false,
    );
    expect(await policy.mfaEnrollmentRequired(null)).toBe(false);
    expect(source.requireMfa).not.toHaveBeenCalled();
    // IAM alone: the environment's policy, which requires nobody.
    expect(await service(null).mfaEnrollmentRequired(user())).toBe(false);
  });

  it('AUTH_MFA=off is the ceiling: a stored requirement has no effect', async () => {
    env.AUTH_MFA = false;
    expect(await service().mfaEnrollmentRequired(user())).toBe(false);
  });

  it("reads the strictest minimum of the account's tenants", async () => {
    expect(await service().passwordMinLength({ userId: 'u1' })).toBe(20);
    expect(memberships).toHaveBeenCalledWith('u1');
    expect(await service().passwordMinLength({ tenantIds: ['t1'] })).toBe(
      PASSWORD_MIN_LENGTH,
    );
    expect(await service(null).passwordMinLength({ userId: 'u1' })).toBe(
      PASSWORD_MIN_LENGTH,
    );
  });

  it("a sign-up meets the one tenant's minimum with TENANCY=single, the floor otherwise", async () => {
    source.passwordMinLength.mockImplementation(async (tenantId: string) =>
      tenantId === 'only' ? 30 : undefined,
    );
    expect(await service().passwordMinLength({ signUp: true })).toBe(
      PASSWORD_MIN_LENGTH,
    );
    expect(source.passwordMinLength).not.toHaveBeenCalled();
    single = true;
    expect(await service().passwordMinLength({ signUp: true })).toBe(30);
  });

  it('refuses a short password with 400 password_too_short on the field', async () => {
    source.passwordMinLength.mockImplementation(async () => 16);
    const refused = await service()
      .assertPasswordLength('a'.repeat(15), 'newPassword', { userId: 'u1' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toMatchObject({
      code: 'password_too_short',
      minLength: 16,
      errors: [{ path: 'newPassword' }],
    });
    await expect(
      service().assertPasswordLength('a'.repeat(16), 'newPassword', {
        userId: 'u1',
      }),
    ).resolves.toBeUndefined();
  });
});
