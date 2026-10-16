import { AsyncLocalStorage } from 'node:async_hooks';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { SignInContext } from '../auth/sign-in-context.js';
import {
  AUTH_TIME_TOLERANCE_MS,
  isFreshAuthentication,
  ProviderReauthentications,
  reauthenticationUrl,
} from './oidc-reauthentication.js';

describe('re-authenticating through a provider', () => {
  it('asks the provider for a fresh login, keeping what the package put in the URL', () => {
    const url = reauthenticationUrl(
      'https://idp.example.com/authorize?client_id=c&state=s1&nonce=n&code_challenge=x&prompt=select_account',
    );
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    for (const [name, value] of [
      ['client_id', 'c'],
      ['state', 's1'],
      ['nonce', 'n'],
      ['code_challenge', 'x'],
    ]) {
      expect(url.searchParams.get(name)).toBe(value);
    }
    expect(url.searchParams.getAll('prompt')).toEqual(['login']);
  });

  it('accepts an auth_time after the start (less the tolerance), or none; refuses an older one', () => {
    const startedAt = Date.parse('2026-10-17T10:00:00Z');
    expect(isFreshAuthentication(new Date(startedAt + 5_000), startedAt)).toBe(
      true,
    );
    expect(
      isFreshAuthentication(
        new Date(startedAt - AUTH_TIME_TOLERANCE_MS),
        startedAt,
      ),
    ).toBe(true);
    expect(
      isFreshAuthentication(
        new Date(startedAt - AUTH_TIME_TOLERANCE_MS - 1_000),
        startedAt,
      ),
    ).toBe(false);
    expect(
      isFreshAuthentication(new Date(startedAt - 3_600_000), startedAt),
    ).toBe(false);
    expect(isFreshAuthentication(undefined, startedAt)).toBe(true);
  });

  it('remembers a step-up by its state for one callback only', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: async (key: string, value: string, px: string, ttl: number) => {
        expect([px, ttl]).toEqual(['PX', 600_000]);
        store.set(key, value);
        return 'OK';
      },
      getdel: async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
    } as unknown as Redis;
    const steps = new ProviderReauthentications(redis);
    const step = { userId: 'u1', startedAt: 1, redirectTo: '/settings' };
    await steps.remember('state-1', step);
    expect(await steps.take('state-2')).toBeUndefined();
    expect(await steps.take('state-1')).toEqual(step);
    expect(await steps.take('state-1')).toBeUndefined();
    for (const state of [undefined, 42, '', 'x'.repeat(257)]) {
      expect(await steps.take(state)).toBeUndefined();
    }
  });

  it('tells the resolver inside the sign-in only', async () => {
    const context = new SignInContext(new ClsService(new AsyncLocalStorage()));
    const step = { userId: 'u1', startedAt: 1 };
    expect(context.reauthenticating()).toBeUndefined();
    expect(
      await context.run('oidc:google', async () => context.reauthenticating(), {
        reauthenticating: step,
      }),
    ).toEqual(step);
    expect(
      await context.run('oidc:google', async () => context.reauthenticating()),
    ).toBeUndefined();
  });
});
