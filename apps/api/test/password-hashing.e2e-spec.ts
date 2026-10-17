import { randomUUID } from 'node:crypto';
import { PasswordHasher } from '@nestjs/authentication';
import type { Response } from 'supertest';
import {
  BoundedPasswordHasher,
  PASSWORD_HASHER_PARAMS,
  PasswordHashLimiter,
} from '../src/iam/account/password-hashing.js';
import { CredentialsService } from '../src/iam/account/credentials.service.js';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads: two hashes at once, four waiting, three
// seconds' wait; /metrics on, with a bearer made up per run.
const BEARER = vi.hoisted(() => {
  const bearer = globalThis.crypto.randomUUID();
  Object.assign(process.env, {
    PASSWORD_HASH_CONCURRENCY: '2',
    PASSWORD_HASH_MAX_QUEUE: '4',
    PASSWORD_HASH_QUEUE_TIMEOUT_MS: '3000',
    METRICS_TOKEN: bearer,
  });
  return bearer;
});

/** A slot of the limiter held until `release()`: the requests then find the process busy. */
function holdSlot(limiter: PasswordHashLimiter) {
  let release!: () => void;
  const done = limiter.run(
    () =>
      new Promise<Buffer>(
        (resolve) => (release = () => resolve(Buffer.alloc(0))),
      ),
  );
  return { release: () => release(), done };
}

/** Every answer: signed in, refused credentials, or 503 server_busy with Retry-After. Never a 500. */
function expectAnsweredOrBusy(responses: Response[]) {
  for (const res of responses) {
    expect([200, 401, 503]).toContain(res.status);
    if (res.status === 503) {
      expect(res.body.code).toBe('server_busy');
      expect(res.headers['retry-after']).toBe('1');
    }
  }
}

/** The token in an email's reset or invitation link. */
const tokenOf = (mail: { link: (match?: string) => URL }) =>
  mail.link('/reset-password').searchParams.get('token')!;

describe('Password hashing under load (e2e)', () => {
  let node: TestApp;
  let limiter: PasswordHashLimiter;
  let email: string;
  let secret: string;

  // From an address of its own each (Caddy's X-Forwarded-For; loopback is
  // trusted): the sign-in limit (5 per email and IP) stays out of the way.
  let client = 0;
  const signIn = (address = email) =>
    node
      .http()
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', `198.51.100.${++client}`)
      .send({ email: address, password: secret });

  /** The refusals counted so far, by reason. */
  async function rejections() {
    const { text } = await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${BEARER}`)
      .expect(200);
    const count = (reason: string) =>
      Number(
        new RegExp(
          `^password_hashes_rejected_total\\{reason="${reason}"\\} (\\d+)`,
          'm',
        ).exec(text)?.[1],
      );
    return { text, full: count('full'), queueTimeout: count('queue-timeout') };
  }

  beforeAll(async () => {
    // N = 2^14 (16 MiB, tens of milliseconds): slow enough that a burst's
    // hashes overlap and queue, as production's do.
    node = await bootApp(undefined, (builder) =>
      builder.overrideProvider(PASSWORD_HASHER_PARAMS).useValue({ logN: 14 }),
    );
    limiter = node.app.get(PasswordHashLimiter);
    email = `${randomUUID().slice(0, 8)}@example.com`;
    secret = await node.acceptAsNew(await node.invite(node.admin(), { email }));
  });
  afterAll(async () => {
    await node.close();
  });
  beforeEach(() => {
    limiter.peak = 0;
  });

  it('hashes with the bounded hasher everywhere, the package’s services included', () => {
    const hasher = node.app.get(PasswordHasher);
    expect(hasher).toBeInstanceOf(BoundedPasswordHasher);
    expect((hasher as BoundedPasswordHasher).limiter).toBe(limiter);
    const credentials = node.app.get(CredentialsService) as unknown as {
      passwordHasher: PasswordHasher;
    };
    expect(credentials.passwordHasher).toBe(hasher);
    expect(limiter.limits).toEqual({
      concurrency: 2,
      maxQueue: 4,
      queueTimeoutMs: 3000,
    });
  });

  it('runs at most two hashes of a burst of sign-ins at once; the rest wait or get 503 server_busy', async () => {
    // A quarter the real account, the rest unknown addresses (the dummy hash: the same work).
    const burst = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        signIn(
          index % 4 === 0 ? email : `nobody-${randomUUID()}@example.com`,
        ).then((res) => res),
      ),
    );
    expectAnsweredOrBusy(burst);
    expect(limiter.peak).toBeGreaterThanOrEqual(1);
    expect(limiter.peak).toBeLessThanOrEqual(2);
    expect(limiter.bulkhead.active).toBe(0);
    expect(limiter.bulkhead.queued).toBe(0);
    // The process is fine afterwards: a sign-in works.
    await signIn().expect(200);
  });

  it('queues four behind a busy limiter and refuses the rest at once', async () => {
    const held = [holdSlot(limiter), holdSlot(limiter)];
    const refused: Response[] = [];
    const burst = Array.from({ length: 10 }, () =>
      signIn().then((res) => {
        if (res.status === 503) {
          refused.push(res);
        }
        return res;
      }),
    );
    // All ten arrived: four wait, six were refused while the slots are held.
    await vi.waitFor(
      () => {
        expect(limiter.bulkhead.queued).toBe(4);
        expect(refused).toHaveLength(6);
      },
      { timeout: 5000 },
    );
    held.forEach((slot) => slot.release());
    await Promise.all(held.map((slot) => slot.done));
    const responses = await Promise.all(burst);
    expectAnsweredOrBusy(responses);
    expect(responses.filter((res) => res.status === 200)).toHaveLength(4);
    expect(responses.filter((res) => res.status === 503)).toHaveLength(6);
    expect(limiter.peak).toBe(2);
  });

  it('refuses a sign-in past the queue or after PASSWORD_HASH_QUEUE_TIMEOUT_MS, and counts each refusal', async () => {
    const before = await rejections();
    const held = [holdSlot(limiter), holdSlot(limiter)];
    try {
      // Five at once behind the two held slots: four wait (then time out), one is refused at once.
      const refused: Response[] = [];
      const burst = Array.from({ length: 5 }, () =>
        signIn().then((res) => {
          refused.push(res);
          return res;
        }),
      );
      await vi.waitFor(
        () => {
          expect(limiter.bulkhead.queued).toBe(4);
          expect(refused).toHaveLength(1);
        },
        { timeout: 5000 },
      );
      const responses = await Promise.all(burst);
      for (const res of responses) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('server_busy');
        expect(res.headers['retry-after']).toBe('1');
      }
    } finally {
      held.forEach((slot) => slot.release());
      await Promise.all(held.map((slot) => slot.done));
    }
    const after = await rejections();
    expect(after.full - before.full).toBe(1);
    expect(after.queueTimeout - before.queueTimeout).toBe(4);
    expect(after.text).toMatch(/^password_hashes_in_flight 0$/m);
    expect(after.text).toMatch(/^password_hashes_queued 0$/m);
  });

  describe('a link spent only when its password is hashed', () => {
    /** The two slots held and the queue full: the next hash is refused at once. */
    function busy() {
      const held = [holdSlot(limiter), holdSlot(limiter)];
      const queued = Array.from({ length: 4 }, () =>
        limiter.run(async () => Buffer.alloc(0)).catch(() => undefined),
      );
      return async () => {
        held.forEach((slot) => slot.release());
        await Promise.all([...held.map((slot) => slot.done), ...queued]);
      };
    }

    /** Busy: 503 and the link kept; free again: the same link sets the password. */
    async function expectLinkSurvivesBusy(
      address: string,
      token: string,
      route = '/v1/auth/password/reset',
      ok = 204,
    ) {
      const release = busy();
      const chosen = newPassword();
      try {
        await vi.waitFor(() => expect(limiter.bulkhead.queued).toBe(4));
        const res = await node
          .http()
          .post(route)
          .send({ token, password: chosen });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('server_busy');
        expect(res.headers['retry-after']).toBe('1');
      } finally {
        await release();
      }
      await node
        .http()
        .post(route)
        .send({ token, password: chosen })
        .expect(ok);
      await node
        .http()
        .post('/v1/auth/sign-in')
        .set('X-Forwarded-For', `198.51.100.${++client}`)
        .send({ email: address, password: chosen })
        .expect(200);
    }

    it('keeps a reset link working after a 503 server_busy', async () => {
      await node
        .http()
        .post('/v1/auth/password/forgot')
        .send({ email })
        .expect(202);
      const mail = await node.waitForMail({
        to: email,
        subject: /Reset your password/,
      });
      await expectLinkSurvivesBusy(email, tokenOf(mail));
    });

    it('keeps an invitation link working after a 503 server_busy', async () => {
      const invited = `${randomUUID().slice(0, 8)}@example.com`;
      const token = await node.invite(node.admin(), { email: invited });
      await expectLinkSurvivesBusy(
        invited,
        token,
        '/v1/auth/invitations/accept',
        200,
      );
    });
  });
});
