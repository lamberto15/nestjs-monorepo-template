import { randomBytes } from 'node:crypto';
import { HttpClient } from '@nestjs/http-client';
import { CaptchaUnavailableError } from './captcha-verifier.js';
import {
  judge,
  type SiteverifyResponse,
  TurnstileVerifier,
} from './turnstile.verifier.js';

const input = {
  token: 'tok',
  ip: '203.0.113.9',
  action: 'sign-in',
  hostnames: ['app.example.com'],
  signal: new AbortController().signal,
};

describe('judge', () => {
  const passed: SiteverifyResponse = {
    success: true,
    hostname: 'app.example.com',
    action: 'sign-in',
  };

  it('passes a success for this host and action', () => {
    expect(judge(passed, input)).toEqual({ ok: true });
  });

  it('compares the host name regardless of case, and accepts an answer without one', () => {
    expect(judge({ ...passed, hostname: 'APP.Example.com' }, input)).toEqual({
      ok: true,
    });
    expect(judge({ success: true, action: 'sign-in' }, input)).toEqual({
      ok: true,
    });
  });

  it('refuses another host, and another action (a token minted elsewhere)', () => {
    expect(judge({ ...passed, hostname: 'evil.example' }, input)).toEqual({
      ok: false,
      reason: 'hostname',
    });
    expect(judge({ ...passed, action: 'sign-up' }, input)).toEqual({
      ok: false,
      reason: 'action',
    });
    // A widget without data-action: refused too (the token must be the route's).
    expect(judge({ ...passed, action: '' }, input)).toEqual({
      ok: false,
      reason: 'action',
    });
    expect(judge({ success: true }, input)).toEqual({
      ok: false,
      reason: 'action',
    });
  });

  it('treats provider-side error codes as an outage, never as an invalid token', () => {
    for (const code of [
      'invalid-input-secret',
      'missing-input-secret',
      'bad-request',
      'internal-error',
    ]) {
      expect(() =>
        judge({ success: false, 'error-codes': [code] }, input),
      ).toThrow(CaptchaUnavailableError);
    }
    expect(
      judge(
        { success: false, 'error-codes': ['missing-input-response'] },
        input,
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it("tells the provider's replay refusal apart from an invalid token", () => {
    expect(
      judge({ success: false, 'error-codes': ['timeout-or-duplicate'] }, input),
    ).toEqual({ ok: false, reason: 'duplicate' });
    expect(
      judge(
        { success: false, 'error-codes': ['invalid-input-response'] },
        input,
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(judge({ success: false }, input)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('TurnstileVerifier', () => {
  // Made at runtime (a local hook refuses key-like literals).
  const secret = `1x${randomBytes(16).toString('hex')}`;
  const siteKey = `1x${randomBytes(11).toString('hex')}`;

  function verifier(fetch: typeof globalThis.fetch): {
    verifier: TurnstileVerifier;
    calls: Request[];
  } {
    const calls: Request[] = [];
    const http = new HttpClient({
      baseUrl: 'https://challenges.example',
      timeout: 500,
      retry: false,
      fetch: (resource, init) => {
        calls.push(new Request(resource, init));
        return fetch(resource, init);
      },
    });
    return {
      verifier: new TurnstileVerifier(http, '/siteverify', secret, siteKey),
      calls,
    };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('posts the secret, the token and the address as JSON, nothing else', async () => {
    const { verifier: turnstile, calls } = verifier(async () =>
      json({ success: true, hostname: 'app.example.com', action: 'sign-in' }),
    );
    await expect(turnstile.verify(input)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://challenges.example/siteverify');
    const body = await calls[0].json();
    expect(body).toMatchObject({
      secret,
      response: 'tok',
      remoteip: '203.0.113.9',
    });
    expect(Object.keys(body).sort()).toEqual([
      'remoteip',
      'response',
      'secret',
    ]);
  });

  it('reports an outage, not a verdict, for a 5xx, a network error or a malformed answer', async () => {
    const outages: (typeof globalThis.fetch)[] = [
      async () => json({ success: false }, 503),
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => json({ hello: 'world' }),
      async () => json({ success: true }, 400),
    ];
    for (const fetch of outages) {
      await expect(
        verifier(fetch).verifier.verify(input),
      ).rejects.toBeInstanceOf(CaptchaUnavailableError);
    }
  });

  it('never puts the secret or the URL in the outage error', async () => {
    const { verifier: turnstile } = verifier(async () =>
      json({ error: 'bad secret' }, 500),
    );
    const error = await turnstile.verify(input).catch((e: Error) => e);
    expect(error).toBeInstanceOf(CaptchaUnavailableError);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('challenges.example');
  });
});
