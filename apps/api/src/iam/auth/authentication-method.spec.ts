import type { SessionRecord } from '@nestjs/authentication';
import {
  authenticationOf,
  type CredentialAuthentication,
  isRecent,
  methodMetadata,
  splitAuthentication,
  tokenClaims,
} from './authentication-method.js';

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'id',
  userId: 'user',
  createdAt: new Date('2026-10-16T10:00:00Z'),
  expiresAt: new Date('2026-10-16T22:00:00Z'),
  lastActiveAt: new Date('2026-10-16T10:00:00Z'),
  ...overrides,
});

describe('authentication method', () => {
  it("reads the package's method strings, provider after the colon", () => {
    expect(methodMetadata('password')).toEqual({ method: 'password' });
    expect(methodMetadata('magic-link')).toEqual({ method: 'magic-link' });
    expect(methodMetadata('oidc:google')).toEqual({
      method: 'oidc',
      provider: 'google',
    });
    expect(methodMetadata('sso:acme:okta')).toEqual({
      method: 'sso',
      provider: 'acme:okta',
    });
  });

  it("reads a session's metadata; an unknown method or a bad time is null", () => {
    expect(
      authenticationOf(
        session({
          mfa: 'verified',
          metadata: {
            method: 'oidc',
            provider: 'github',
            authenticatedAt: '2026-10-16T10:00:00.000Z',
          },
        }),
      ),
    ).toEqual({
      via: 'session',
      method: 'oidc',
      provider: 'github',
      mfa: true,
      authenticatedAt: new Date('2026-10-16T10:00:00Z'),
    });
    expect(
      authenticationOf(
        session({
          metadata: { method: 'carrier-pigeon', authenticatedAt: 'x' },
        }),
      ),
    ).toMatchObject({ method: null, authenticatedAt: null, mfa: false });
  });

  it("reads a token's amr and auth_time", () => {
    const at = new Date('2026-10-16T10:00:00Z');
    expect(
      authenticationOf({ sub: 'user', ...tokenClaims(['pwd', 'mfa'], at) }),
    ).toEqual({
      via: 'token',
      method: 'password',
      provider: null,
      mfa: true,
      authenticatedAt: at,
    });
    // A passkey's token (RFC 8176 `pop`), with its second factor or without.
    expect(
      authenticationOf({ sub: 'user', ...tokenClaims(['pop'], at) }),
    ).toMatchObject({ via: 'token', method: 'passkey', mfa: false });
    expect(
      authenticationOf({ sub: 'user', ...tokenClaims(['pop', 'mfa'], at) }),
    ).toMatchObject({ method: 'passkey', mfa: true });
    // A token from before auth_time was recorded: never recent.
    expect(authenticationOf({ sub: 'user' })).toMatchObject({
      authenticatedAt: null,
    });
    expect(tokenClaims([], at, null, 'family')).toEqual({
      auth_time: at.getTime() / 1000,
      sid: 'family',
    });
    // Each sign-in starts a family of its own: its own `sid`.
    expect(tokenClaims([], at).sid).not.toBe(tokenClaims([], at).sid);
  });

  it("reads a native handoff's method from a token without amr", () => {
    const at = new Date('2026-10-16T10:00:00Z');
    const claims = (method: string) => ({
      sub: 'user',
      ...tokenClaims([], at, null, undefined, method),
    });
    expect(authenticationOf(claims('sso:connection'))).toMatchObject({
      via: 'token',
      method: 'sso',
      provider: 'connection',
    });
    expect(authenticationOf(claims('magic-link'))).toMatchObject({
      method: 'magic-link',
      provider: null,
    });
    expect(authenticationOf(claims('carrier-pigeon'))).toMatchObject({
      method: null,
    });
  });

  it('is null for an API key and for nothing', () => {
    expect(authenticationOf({ keyId: 'k', clientId: 'c' })).toBeNull();
    expect(authenticationOf(null)).toBeNull();
  });

  it('splits the authentication keys off the rest of the metadata', () => {
    expect(
      splitAuthentication({
        userAgent: 'UA',
        method: 'password',
        authenticatedAt: '2026-10-16T10:00:00.000Z',
      }),
    ).toEqual({
      rest: { userAgent: 'UA' },
      authentication: {
        method: 'password',
        authenticatedAt: '2026-10-16T10:00:00.000Z',
      },
    });
    expect(splitAuthentication(undefined)).toEqual({
      rest: {},
      authentication: {},
    });
  });

  describe('isRecent', () => {
    const now = Date.parse('2026-10-16T10:00:00Z');
    const authentication = (
      at: string | null,
      method: CredentialAuthentication['method'] = 'password',
    ): CredentialAuthentication => ({
      via: 'session',
      method,
      provider: null,
      mfa: false,
      authenticatedAt: at ? new Date(at) : null,
    });
    const until = (at: string) => new Date(Date.parse(at) + 10 * 60_000);

    it('is recent before recentUntil, not at or after it', () => {
      const at = '2026-10-16T09:55:00Z';
      expect(isRecent(authentication(at), until(at), now)).toBe(true);
      expect(
        isRecent(
          authentication(at),
          until(at),
          Date.parse(until(at).toISOString()),
        ),
      ).toBe(false);
      expect(isRecent(authentication(at), until(at), now + 60 * 60_000)).toBe(
        false,
      );
    });

    it('allows another instance a minute of clock skew, not more', () => {
      const skewed = '2026-10-16T10:00:59Z';
      expect(isRecent(authentication(skewed), until(skewed), now)).toBe(true);
      const future = '2026-10-16T10:01:01Z';
      expect(isRecent(authentication(future), until(future), now)).toBe(false);
    });

    it('is never recent without a time, without an authentication, or for an impersonation', () => {
      expect(isRecent(authentication(null), null, now)).toBe(false);
      expect(isRecent(null, until('2026-10-16T09:59:00Z'), now)).toBe(false);
      const at = '2026-10-16T09:59:00Z';
      expect(
        isRecent(authentication(at, 'impersonation'), until(at), now),
      ).toBe(false);
    });
  });
});
