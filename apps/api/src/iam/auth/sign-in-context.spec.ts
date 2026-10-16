import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import {
  authTimeOf,
  SignInContext,
  signInMetadata,
} from './sign-in-context.js';

describe('sign-in context', () => {
  const cls = new ClsService(new AsyncLocalStorage());
  const context = new SignInContext(cls);

  it('records the method, and the time now, for the session created inside run()', async () => {
    const before = Date.now();
    const recorded = await context.run('oidc:google', async () =>
      signInMetadata(cls),
    );
    expect(recorded).toMatchObject({ method: 'oidc', provider: 'google' });
    expect(Date.parse(recorded.authenticatedAt!)).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("takes the sign-in's own time when it tells one", async () => {
    const at = new Date('2026-10-16T09:30:00Z');
    const recorded = await context.run('oidc:google', async () => {
      context.authenticatedAt(at);
      return signInMetadata(cls);
    });
    expect(recorded.authenticatedAt).toBe(at.toISOString());
  });

  it('reads an auth_time a session can record, and nothing else', () => {
    expect(authTimeOf({ auth_time: 1_760_000_000 })).toEqual(
      new Date(1_760_000_000_000),
    );
    expect(authTimeOf({ auth_time: '1760000000' })).toBeUndefined();
    expect(authTimeOf({ auth_time: Number.NaN })).toBeUndefined();
    expect(authTimeOf({ auth_time: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(authTimeOf({ auth_time: 1e13 })).toBeUndefined(); // past Date's range
    expect(authTimeOf({})).toBeUndefined();
    expect(authTimeOf(undefined)).toBeUndefined();
  });

  it('is only the time outside a sign-in, and keeps sign-ins apart', async () => {
    expect(signInMetadata(cls)).not.toHaveProperty('method');
    context.authenticatedAt(new Date(0)); // nothing to tell: ignored
    expect(
      Date.now() - Date.parse(signInMetadata(cls).authenticatedAt!),
    ).toBeLessThan(1000);
    await cls.run(async () => {
      cls.set('other', 1);
      const inner = await context.run('magic-link', async () =>
        signInMetadata(cls),
      );
      expect(inner.method).toBe('magic-link');
      expect(cls.get('other')).toBe(1);
      expect(signInMetadata(cls)).not.toHaveProperty('method');
    });
  });
});
