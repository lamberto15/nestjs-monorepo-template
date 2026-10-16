import { Logger } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import { createLogger } from '../src/core/logging/logging.js';
import { REDACTED } from '../src/core/logging/redaction.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The application's logs, as production writes them (JSON, every level),
 * captured instead of written: the logger's `forceConsole` sends each line
 * to console.log/console.error, which the test takes over.
 */
describe('log redaction', () => {
  let node: TestApp;
  const lines: string[] = [];
  let spies: MockInstance[] = [];

  beforeEach(async () => {
    lines.length = 0;
    const take = (line: unknown) => {
      lines.push(String(line));
    };
    spies = [
      vi.spyOn(console, 'log').mockImplementation(take),
      vi.spyOn(console, 'error').mockImplementation(take),
    ];
    node = await bootApp();
    node.app.useLogger(
      createLogger(
        { LOG_FORMAT: 'json', LOG_LEVEL: 'verbose' },
        { forceConsole: true },
      ),
    );
  });

  afterEach(async () => {
    await node.close();
    Logger.overrideLogger(false);
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  const output = () => lines.join('\n');

  it('keeps a password sign-in and a bearer-token request out of the logs', async () => {
    const email = process.env.ADMIN_EMAIL!;
    const password = process.env.ADMIN_PASSWORD!;

    // A browser signs in with the password and gets a session cookie.
    const signedIn = await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const cookie = String(signedIn.headers['set-cookie']?.[0] ?? '');
    const sessionId = /sid=([^;]+)/.exec(cookie)?.[1];
    expect(sessionId).toBeTruthy();
    await node.http().get('/v1/auth/me').set('Cookie', cookie).expect(200);

    // A native app signs in with the password and gets tokens; the bearer
    // token opens a route, is refused on another, and a wrong one is refused.
    const issued = await node
      .http()
      .post('/v1/auth/token')
      .send({ email, password })
      .expect(200);
    const { accessToken, refreshToken } = issued.body as {
      accessToken: string;
      refreshToken: string;
    };
    await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await node
      .http()
      .get('/v1/nowhere')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
    await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}x`)
      .expect(401);
    await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email, password: `${password}-wrong` })
      .expect(401);
    // A validation error names the field, never echoes its value: neither
    // the problem details nor the logs carry the password.
    const invalid = await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email: 'not-an-email', password })
      .expect(400);
    expect(invalid.body.code).toBe('validation_failed');
    expect(JSON.stringify(invalid.body)).not.toContain(password);

    // The request log wrote one line per request...
    expect(output()).toContain('"message":"POST /v1/auth/sign-in 200"');
    expect(output()).toContain('"message":"GET /v1/nowhere 404"');
    expect(output()).toContain('"message":"GET /v1/auth/me 401"');
    // ...and nothing anyone wrote holds a credential.
    for (const secret of [password, sessionId!, accessToken, refreshToken]) {
      expect(output()).not.toContain(secret);
    }
  });

  it('masks what a handler logs of a request, structured or as text', async () => {
    const email = process.env.ADMIN_EMAIL!;
    const password = process.env.ADMIN_PASSWORD!;
    const issued = await node
      .http()
      .post('/v1/auth/token')
      .send({ email, password })
      .expect(200);
    const { accessToken } = issued.body as { accessToken: string };
    const logger = new Logger('Handler');

    // The request, logged whole by a careless handler.
    logger.warn('request', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `__Host-sid=${accessToken}`,
        'x-captcha-token': accessToken,
        'user-agent': 'test-agent',
      },
      body: { email, password, code: '123456' },
    });
    // The credential interpolated into a message and into an error.
    logger.error(`sign-in failed for ${email} with password=${password}`);
    logger.error(
      new Error(`upstream refused Authorization: Bearer ${accessToken}`),
    );
    // A job's failure, as a processor logs it.
    logger.error(
      'job failed',
      `Error: token ${accessToken} expired\n    at run`,
    );

    for (const secret of [password, accessToken]) {
      expect(output()).not.toContain(secret);
    }
    expect(output()).toContain(REDACTED);
    expect(output()).toContain('test-agent');
    expect(output()).toContain(email);
    expect(output()).not.toContain('123456');
  });
});
