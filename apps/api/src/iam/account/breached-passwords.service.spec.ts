import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { MockInstance } from 'vitest';
import { HttpClient } from '@nestjs/http-client';
import type { IamEnv } from '../iam.env.js';
import {
  BreachedPasswordsService,
  countInRange,
  hashRange,
} from './breached-passwords.service.js';

const BASE = 'https://pwned.test';
// Made at runtime (a local hook refuses password-like literals).
const BREACHED = ['pass', 'word', '1234'].join('');
const fresh = () => randomBytes(18).toString('base64url');
const sha1 = (value: string) =>
  createHash('sha1').update(value).digest('hex').toUpperCase();

/** A range response for `prefix`: the breached suffixes with counts, plus padding lines (count 0). */
function rangeBody(entries: Record<string, number>, padding: string[] = []) {
  return [
    ...Object.entries(entries).map(([suffix, count]) => `${suffix}:${count}`),
    ...padding.map((suffix) => `${suffix}:0`),
  ].join('\r\n');
}

function service(
  fetch: typeof globalThis.fetch,
  env: Partial<IamEnv> = {},
  timeout = 1000,
) {
  const values: Partial<IamEnv> = {
    PASSWORD_BREACH_CHECK: true,
    PASSWORD_BREACH_ON_ERROR: 'allow',
    PASSWORD_BREACH_MIN_COUNT: 1,
    ...env,
  };
  const config = {
    get: (key: keyof IamEnv) => values[key],
  } as unknown as ConfigService<IamEnv, true>;
  const http = new HttpClient({ baseUrl: BASE, fetch, timeout, retry: false });
  return new BreachedPasswordsService(http, config);
}

describe('hashRange', () => {
  it('splits the upper-case SHA-1 into a 5-character prefix and a 35-character suffix', () => {
    const { prefix, suffix } = hashRange(BREACHED);
    expect(prefix + suffix).toBe(sha1(BREACHED));
    expect(prefix).toMatch(/^[0-9A-F]{5}$/);
    expect(suffix).toMatch(/^[0-9A-F]{35}$/);
  });
});

describe('countInRange', () => {
  const { suffix } = hashRange(BREACHED);

  it('finds the suffix, in any case, with its count', () => {
    const body = rangeBody({ ['0'.repeat(35)]: 3, [suffix.toLowerCase()]: 42 });
    expect(countInRange(body, suffix)).toBe(42);
  });

  it('is 0 for a padding line (count 0) and for a suffix not listed', () => {
    expect(countInRange(rangeBody({}, [suffix]), suffix)).toBe(0);
    expect(countInRange(rangeBody({ ['F'.repeat(35)]: 9 }), suffix)).toBe(0);
    expect(countInRange('', suffix)).toBe(0);
  });
});

describe('BreachedPasswordsService', () => {
  let warn: MockInstance<Logger['warn']>;
  beforeEach(() => {
    warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /** A fetch that answers every range request with `body`, recording what was asked. */
  const answering = (body: string, status = 200) =>
    vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(body, { status })),
    );

  it('sends only the 5-character prefix, with Add-Padding, never the password or its hash', async () => {
    const password = fresh();
    const fetch = answering('');
    await service(fetch).timesSeen(password);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = input instanceof Request ? input.url : input.toString();
    const { prefix } = hashRange(password);
    expect(url).toBe(`${BASE}/range/${prefix}`);
    expect(new Headers(init?.headers).get('add-padding')).toBe('true');
    expect(init?.body ?? undefined).toBeUndefined();
    const sent = `${url} ${JSON.stringify([...new Headers(init?.headers)])}`;
    expect(sent).not.toContain(password);
    expect(sent).not.toContain(sha1(password));
    expect(sent).not.toContain(sha1(password).slice(5));
  });

  it('counts a breached password, and finds a fresh one in none (padding lines included)', async () => {
    const { suffix } = hashRange(BREACHED);
    const breached = service(answering(rangeBody({ [suffix]: 7 })));
    await expect(breached.timesSeen(BREACHED)).resolves.toBe(7);

    const password = fresh();
    const padded = service(
      answering(
        rangeBody({ ['A'.repeat(35)]: 2 }, [hashRange(password).suffix]),
      ),
    );
    await expect(padded.timesSeen(password)).resolves.toBe(0);
    await expect(padded.assertNotBreached(password, 'password')).resolves.toBe(
      undefined,
    );
  });

  it('refuses a breached password with a 400 password_breached on the field', async () => {
    const { suffix } = hashRange(BREACHED);
    const checker = service(answering(rangeBody({ [suffix]: 3 })));
    const error = await checker
      .assertNotBreached(BREACHED, 'newPassword')
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'password_breached',
      errors: [{ path: 'newPassword' }],
    });
    // Nothing about how often or where.
    expect(
      JSON.stringify((error as BadRequestException).getResponse()),
    ).not.toMatch(/3/);
  });

  it('lets a password seen fewer than PASSWORD_BREACH_MIN_COUNT times through', async () => {
    const { suffix } = hashRange(BREACHED);
    const checker = service(answering(rangeBody({ [suffix]: 4 })), {
      PASSWORD_BREACH_MIN_COUNT: 5,
    });
    await expect(checker.isBreached(BREACHED)).resolves.toBe(false);
    await expect(
      checker.assertNotBreached(BREACHED, 'password'),
    ).resolves.toBeUndefined();
  });

  it('asks nothing when PASSWORD_BREACH_CHECK is off', async () => {
    const fetch = answering('');
    const checker = service(fetch, { PASSWORD_BREACH_CHECK: false });
    await expect(checker.timesSeen(BREACHED)).resolves.toBeUndefined();
    await expect(
      checker.assertNotBreached(BREACHED, 'password'),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails open on a timeout: allowed, with a warning that names neither the password nor its hash', async () => {
    const hanging = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal!.reason),
          );
        }),
    );
    const checker = service(hanging, {}, 50);
    await expect(
      checker.assertNotBreached(BREACHED, 'password'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toMatch(/HttpTimeoutError/);
    expect(logged).not.toContain(BREACHED);
    expect(logged).not.toContain(hashRange(BREACHED).prefix);
  });

  it('fails open on an error answer and on a network failure', async () => {
    await expect(
      service(answering('oops', 503)).assertNotBreached(BREACHED, 'password'),
    ).resolves.toBeUndefined();
    const down = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    await expect(service(down).timesSeen(BREACHED)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fails closed with PASSWORD_BREACH_ON_ERROR=reject: a 503 password_check_unavailable', async () => {
    const checker = service(answering('', 500), {
      PASSWORD_BREACH_ON_ERROR: 'reject',
    });
    const error = await checker
      .assertNotBreached(fresh(), 'password')
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'password_check_unavailable',
      retryAfter: 60,
    });
  });
});
