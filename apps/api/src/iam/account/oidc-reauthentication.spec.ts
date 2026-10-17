import { AsyncLocalStorage } from 'node:async_hooks';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { SignInContext } from '../auth/sign-in-context.js';
import {
  AUTH_TIME_TOLERANCE_MS,
  isFreshAuthentication,
  ProviderReauthentications,
  reauthenticationCookie,
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

  it('accepts an auth_time after the start (less the tolerance); refuses an older one', () => {
    const startedAt = Date.parse('2026-10-17T10:00:00Z');
    for (const requireAuthTime of [true, false]) {
      const fresh = (at: Date) =>
        isFreshAuthentication(at, startedAt, { requireAuthTime });
      expect(fresh(new Date(startedAt + 5_000))).toBe(true);
      expect(fresh(new Date(startedAt - AUTH_TIME_TOLERANCE_MS))).toBe(true);
      expect(fresh(new Date(startedAt - AUTH_TIME_TOLERANCE_MS - 1_000))).toBe(
        false,
      );
      expect(fresh(new Date(startedAt - 3_600_000))).toBe(false);
    }
  });

  it('wants auth_time from an OpenID Connect provider; plain OAuth 2.0 (no ID token) goes without', () => {
    const startedAt = Date.now();
    expect(
      isFreshAuthentication(undefined, startedAt, { requireAuthTime: true }),
    ).toBe(false);
    expect(
      isFreshAuthentication(undefined, startedAt, { requireAuthTime: false }),
    ).toBe(true);
  });

  it('names the step-up cookie by its Secure flag, and reads back only its own', () => {
    const secure = reauthenticationCookie(true);
    expect(secure.name).toBe('__Host-oidc_reauth');
    expect(secure.set('s1')).toBe(
      '__Host-oidc_reauth=s1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure',
    );
    expect(secure.clear()).toMatch(
      /^__Host-oidc_reauth=; .*Max-Age=0; Secure$/,
    );
    const plain = reauthenticationCookie(false);
    expect(plain.set('s1')).not.toContain('Secure');
    expect(plain.read('sid=x; oidc_reauth=s%2B1; other=y')).toBe('s+1');
    expect(plain.read('sid=x; xoidc_reauth=s1')).toBeUndefined();
    expect(plain.read(undefined)).toBeUndefined();
    expect(plain.read('oidc_reauth=%E0%A4%A')).toBeUndefined();
  });

  it('reads a step-up by its state without taking it, until it is forgotten', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: async (key: string, value: string, px: string, ttl: number) => {
        expect([px, ttl]).toEqual(['PX', 600_000]);
        store.set(key, value);
        return 'OK';
      },
      get: async (key: string) => store.get(key) ?? null,
      del: async (key: string) => (store.delete(key) ? 1 : 0),
    } as unknown as Redis;
    const steps = new ProviderReauthentications(redis);
    const step = { userId: 'u1', startedAt: 1, redirectTo: '/settings' };
    await steps.remember('state-1', step);
    expect(await steps.peek('state-2')).toBeUndefined();
    // A callback that fails the package's checks reads it: still there.
    expect(await steps.peek('state-1')).toEqual(step);
    expect(await steps.peek('state-1')).toEqual(step);
    await steps.forget('state-1');
    expect(await steps.peek('state-1')).toBeUndefined();
    for (const state of [undefined, 42, '', 'x'.repeat(257)]) {
      expect(await steps.peek(state)).toBeUndefined();
      await steps.forget(state);
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
