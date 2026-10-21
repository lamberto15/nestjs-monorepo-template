import type { ConfigService } from '@nestjs/config';
import { RefreshTokenError, type SessionRecord } from '@nestjs/authentication';
import type { MfaService } from '@nestjs/authentication';
import type { SingleTenant } from '../access/single-tenant.js';
import type { IamEnv } from '../iam.env.js';
import {
  effectiveSessionLimit,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
  sessionCeilingRefusal,
} from './auth-policy.js';
import { AuthPolicyService } from './auth-policy.service.js';
import type { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';
import { SessionLifetime } from './session-lifetime.js';
import type { UsersRepository } from './users.repository.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ceiling = { SESSION_IDLE_MINUTES: 120, SESSION_MAX_HOURS: 12 };

describe('session limits under the ceiling', () => {
  it('takes the tenant’s choice when shorter, else the environment’s', () => {
    expect(effectiveSessionLimit(120, 30)).toBe(30);
    expect(effectiveSessionLimit(120, 500)).toBe(120);
    expect(effectiveSessionLimit(120, undefined)).toBe(120);
    expect(effectiveSessionLimit(120, Number.NaN)).toBe(120);
    expect(effectiveSessionLimit(120, 0)).toBe(120);
  });

  it('refuses to store a limit over the ceiling, nothing else', () => {
    expect(sessionCeilingRefusal(ceiling, 'sessionIdleMinutes', 121)).toMatch(
      /SESSION_IDLE_MINUTES is 120/,
    );
    expect(sessionCeilingRefusal(ceiling, 'sessionIdleMinutes', 120)).toBe(
      undefined,
    );
    expect(sessionCeilingRefusal(ceiling, 'sessionMaxHours', 13)).toMatch(
      /SESSION_MAX_HOURS is 12/,
    );
    expect(sessionCeilingRefusal(ceiling, 'sessionMaxHours', 1)).toBe(
      undefined,
    );
  });
});

describe('SessionLifetime', () => {
  const chosen: { idle?: number; max?: number } = {};
  const source = {
    requireMfa: async () => false,
    passwordMinLength: async () => undefined,
    sessionIdleMinutes: async () => chosen.idle ?? SESSION_IDLE_MINUTES_LIMIT,
    sessionMaxHours: async () => chosen.max ?? SESSION_MAX_HOURS_LIMIT,
  };
  const family = { first: new Date(0), last: new Date(0) };
  const revoked: string[] = [];
  const store = {
    getRefreshToken: vi.fn(async () => ({
      familyId: 'f1',
      claims: { tid: 't1' },
    })),
    refreshTokenFamilyBounds: vi.fn(async () => family),
    revokeRefreshTokenFamily: vi.fn(async (id: string) => {
      revoked.push(id);
    }),
  };
  const lifetime = () =>
    new SessionLifetime(
      new AuthPolicyService(
        {
          get: (key: keyof typeof ceiling) => ceiling[key],
        } as unknown as ConfigService<IamEnv, true>,
        {} as MfaService,
        {} as UsersRepository,
        {} as SingleTenant,
        source,
      ),
      store as unknown as DrizzleAuthenticationStore,
    );
  const session = (
    createdAgo: number,
    idleAgo: number,
    now: number,
  ): SessionRecord => ({
    id: 's',
    userId: 'u',
    createdAt: new Date(now - createdAgo),
    expiresAt: new Date(now + HOUR),
    lastActiveAt: new Date(now),
    extra: { previousActiveAt: new Date(now - idleAgo) },
  });

  beforeEach(() => {
    delete chosen.idle;
    delete chosen.max;
    revoked.length = 0;
    vi.clearAllMocks();
  });

  describe('expired', () => {
    const now = Date.UTC(2026, 9, 21, 12);

    it('is never expired under the environment’s limits when the tenant chose none', async () => {
      expect(
        await lifetime().expired(
          session(11 * HOUR, 119 * MINUTE, now),
          't1',
          now,
        ),
      ).toBe(false);
    });

    it('ends at the tenant’s idle timeout, judged on the activity before the request', async () => {
      chosen.idle = 10;
      expect(
        await lifetime().expired(session(HOUR, 9 * MINUTE, now), 't1', now),
      ).toBe(false);
      expect(
        await lifetime().expired(session(HOUR, 10 * MINUTE, now), 't1', now),
      ).toBe(true);
    });

    it('ends at the tenant’s maximum lifetime, however active', async () => {
      chosen.max = 2;
      expect(
        await lifetime().expired(session(119 * MINUTE, 0, now), 't1', now),
      ).toBe(false);
      expect(
        await lifetime().expired(session(2 * HOUR, 0, now), 't1', now),
      ).toBe(true);
    });

    it('uses the environment’s limits without a tenant', async () => {
      chosen.idle = 5;
      expect(
        await lifetime().expired(session(HOUR, 30 * MINUTE, now), null, now),
      ).toBe(false);
    });
  });

  describe('assertRefreshable', () => {
    const now = Date.UTC(2026, 9, 21, 12);

    it('lets a family pass when the tenant chose nothing, however old', async () => {
      family.first = new Date(now - 60 * 24 * HOUR);
      family.last = new Date(now - 29 * 24 * HOUR);
      await expect(
        lifetime().assertRefreshable('token', now),
      ).resolves.toBeUndefined();
      expect(store.refreshTokenFamilyBounds).not.toHaveBeenCalled();
    });

    it('revokes and refuses a family past the tenant’s maximum lifetime', async () => {
      chosen.max = 1;
      family.first = new Date(now - 2 * HOUR);
      family.last = new Date(now - MINUTE);
      const refused = await lifetime()
        .assertRefreshable('token', now)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(RefreshTokenError);
      expect(revoked).toEqual(['f1']);
    });

    it('counts idle from the last refresh plus the access token’s lifetime', async () => {
      chosen.idle = 10;
      family.first = new Date(now - HOUR);
      family.last = new Date(now - 24 * MINUTE);
      await expect(
        lifetime().assertRefreshable('token', now),
      ).resolves.toBeUndefined();
      family.last = new Date(now - 25 * MINUTE);
      await expect(
        lifetime().assertRefreshable('token', now),
      ).rejects.toThrow();
      expect(revoked).toEqual(['f1']);
    });

    it('leaves an unknown token to the package', async () => {
      chosen.max = 1;
      store.getRefreshToken.mockResolvedValueOnce(undefined as never);
      await expect(
        lifetime().assertRefreshable('nope', now),
      ).resolves.toBeUndefined();
    });
  });
});
