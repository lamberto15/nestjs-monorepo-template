import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TransactionHost } from '@nestjs-cls/transactional';
import type { Redis } from 'ioredis';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import type { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { IamEnv } from '../iam.env.js';
import {
  type BreachedPasswordsService,
  hashRange,
} from './breached-passwords.service.js';
import type { SecurityAlertsService } from './security-alerts.service.js';
import { recheckKey, SignInPasswordCheck } from './sign-in-password-check.js';

const user = {
  kind: 'user',
  id: 'u-1',
  email: 'ada@example.com',
} as UserPrincipal;
const HASH = '$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA';
const password = () => randomBytes(18).toString('base64url');

/** Redis' SET … NX EX and DEL, in memory. */
function fakeRedis() {
  const keys = new Map<string, number>();
  return {
    keys,
    set: vi.fn(
      async (
        key: string,
        _value: string,
        _ex: 'EX',
        ttl: number,
        _nx: 'NX',
      ) => {
        if (keys.has(key)) {
          return null;
        }
        keys.set(key, ttl);
        return 'OK';
      },
    ),
    del: vi.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
  };
}

function setup(options: {
  enabled?: boolean;
  breached?: boolean | undefined | Promise<boolean | undefined>;
}) {
  const redis = fakeRedis();
  const breached = {
    enabled: options.enabled ?? true,
    isBreachedIn: vi.fn(() =>
      Promise.resolve('breached' in options ? options.breached : false),
    ),
  };
  const alerts = {
    credentialsChanged: vi.fn(async () => true),
    deliverNow: vi.fn(),
  };
  const tx = {};
  const txHost = {
    withTransaction: (work: () => Promise<unknown>) => work(),
    tx,
  };
  const tenancy = { none: (work: () => Promise<unknown>) => work() };
  const config = {
    get: (key: keyof IamEnv) =>
      key === 'PASSWORD_BREACH_RECHECK_DAYS' ? 30 : undefined,
  };
  const check = new SignInPasswordCheck(
    breached as unknown as BreachedPasswordsService,
    alerts as unknown as SecurityAlertsService,
    txHost as unknown as TransactionHost<DrizzleTransactions>,
    tenancy as unknown as Tenancy,
    config as unknown as ConfigService<IamEnv, true>,
    redis as unknown as Redis,
  );
  return { check, redis, breached, alerts, tx };
}

describe('recheckKey', () => {
  it('names the account and a digest of its stored hash, never the hash itself', () => {
    const key = recheckKey('u-1', HASH);
    expect(key).toMatch(/^password-breach:u-1:[\w-]{16}$/);
    expect(key).not.toContain('c2FsdA');
    expect(recheckKey('u-1', HASH)).toBe(key);
  });

  it('changes with the password (a new salted hash) and with the account', () => {
    expect(recheckKey('u-1', `${HASH}x`)).not.toBe(recheckKey('u-1', HASH));
    expect(recheckKey('u-2', HASH)).not.toBe(recheckKey('u-1', HASH));
  });
});

describe('SignInPasswordCheck', () => {
  afterEach(() => vi.restoreAllMocks());

  it('flags a breached password: audited and told, in one transaction, then delivered', async () => {
    const { check, alerts, tx } = setup({ breached: true });
    await expect(
      check.check(user, hashRange(password()), HASH, '127.0.0.1'),
    ).resolves.toBe('breached');
    expect(alerts.credentialsChanged).toHaveBeenCalledWith(tx, user, 'u-1', {
      action: 'auth.password-breached',
      ip: '127.0.0.1',
      type: 'security.passwordBreached',
      data: { at: expect.any(String) },
      link: '/account/security',
    });
    expect(alerts.deliverNow).toHaveBeenCalledOnce();
  });

  it('flags nothing for a clean password', async () => {
    const { check, alerts } = setup({ breached: false });
    await expect(
      check.check(user, hashRange(password()), HASH, '127.0.0.1'),
    ).resolves.toBe('clean');
    expect(alerts.credentialsChanged).not.toHaveBeenCalled();
  });

  it('checks one password once per PASSWORD_BREACH_RECHECK_DAYS, a new one at once', async () => {
    const { check, redis, breached, alerts } = setup({ breached: true });
    const range = hashRange(password());
    await check.check(user, range, HASH, '127.0.0.1');
    await expect(check.check(user, range, HASH, '127.0.0.1')).resolves.toBe(
      'recent',
    );
    expect(breached.isBreachedIn).toHaveBeenCalledOnce();
    expect(alerts.credentialsChanged).toHaveBeenCalledOnce();
    expect([...redis.keys.values()]).toEqual([30 * 86_400]);

    // A new password (a new hash): checked again.
    await expect(
      check.check(user, hashRange(password()), `${HASH}2`, '127.0.0.1'),
    ).resolves.toBe('breached');
    expect(breached.isBreachedIn).toHaveBeenCalledTimes(2);
  });

  it('releases the key when the API gave no answer, so the next sign-in tries again', async () => {
    const { check, redis, breached } = setup({ breached: undefined });
    const range = hashRange(password());
    await expect(check.check(user, range, HASH, '127.0.0.1')).resolves.toBe(
      'unknown',
    );
    expect(redis.keys.size).toBe(0);
    await check.check(user, range, HASH, '127.0.0.1');
    expect(breached.isBreachedIn).toHaveBeenCalledTimes(2);
  });

  it('does nothing when PASSWORD_BREACH_CHECK is off', async () => {
    const { check, redis, breached } = setup({ enabled: false });
    await expect(
      check.check(user, hashRange(password()), HASH, '127.0.0.1'),
    ).resolves.toBe('off');
    check.start(user, password(), HASH, '127.0.0.1');
    await check.settled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(breached.isBreachedIn).not.toHaveBeenCalled();
  });

  it('start() returns before the API answers, and hands on only the split hash', async () => {
    let answer!: (breached: boolean) => void;
    const pending = new Promise<boolean | undefined>((resolve) => {
      answer = resolve;
    });
    const { check, breached, alerts } = setup({ breached: pending });
    const secret = password();
    check.start(user, secret, HASH, '127.0.0.1');
    // Returned at once: nothing flagged yet.
    expect(alerts.credentialsChanged).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(breached.isBreachedIn).toHaveBeenCalled());
    expect(breached.isBreachedIn).toHaveBeenCalledWith(hashRange(secret));
    expect(JSON.stringify(breached.isBreachedIn.mock.calls)).not.toContain(
      secret,
    );

    answer(true);
    await check.settled();
    expect(alerts.credentialsChanged).toHaveBeenCalledOnce();
  });

  it('never throws from start(): a failure is logged by kind, without the password', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { check, redis } = setup({ breached: true });
    redis.set.mockRejectedValueOnce(new TypeError('connection lost'));
    const secret = password();
    expect(() => check.start(user, secret, HASH, '127.0.0.1')).not.toThrow();
    await check.settled();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('TypeError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('connection lost');
  });
});
