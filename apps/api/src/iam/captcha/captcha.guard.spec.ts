import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthenticationError,
  type SessionService,
  type TokenService,
} from '@nestjs/authentication';
import type { AccountService } from '../account/account.service.js';
import { TokensController } from '../account/tokens.controller.js';
import type { UsersRepository } from '../auth/users.repository.js';
import { Captcha, CaptchaGuard, type CaptchaOptions } from './captcha.guard.js';
import type { CaptchaRequest, CaptchaService } from './captcha.service.js';

/** What the guard told the service: each check's subject, each release's. */
function fakeCaptcha() {
  const checked: CaptchaRequest[] = [];
  const released: Pick<CaptchaRequest, 'ip' | 'email'>[] = [];
  const service = {
    mode: 'after-failures',
    check: async (_token: string | undefined, subject: CaptchaRequest) => {
      checked.push(subject);
    },
    release: async (subject: Pick<CaptchaRequest, 'ip' | 'email'>) => {
      released.push(subject);
    },
  } as unknown as CaptchaService;
  return { service, checked, released };
}

/** A route decorated with @Captcha(options), and a request to it. */
function call(
  options: CaptchaOptions,
  request: {
    body?: unknown;
    headers?: Record<string, string>;
    cookieSession?: { userId: string } | null;
  },
) {
  class Route {
    @Captcha(options)
    handle(this: void) {}
  }
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const req = {
    ip: '203.0.113.7',
    body: request.body,
    headers: request.headers ?? {},
    method: 'POST',
  };
  const context = {
    getType: () => 'http',
    getHandler: () => Route.prototype.handle,
    getClass: () => Route,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  const tokensRead: unknown[] = [];
  const sessions = {
    tokenFrom: (r: unknown) => {
      tokensRead.push(r);
      return request.cookieSession ? 'cookie-token' : undefined;
    },
    validate: async (token: string | undefined) =>
      token && request.cookieSession
        ? { id: 's1', userId: request.cookieSession.userId }
        : null,
  } as unknown as SessionService;
  const users = {
    findView: async (id: string) =>
      id === 'u1' ? { id, email: 'Pending@Example.com' } : null,
  } as unknown as UsersRepository;
  return { context, response, sessions, users, tokensRead };
}

describe('CaptchaGuard: the account an attempt names', () => {
  it("reads the body's email by default", async () => {
    const captcha = fakeCaptcha();
    const route = call(
      { action: 'sign-in', count: 'failures' },
      { body: { email: 'someone@example.com' } },
    );
    const guard = new CaptchaGuard(
      new Reflector(),
      captcha.service,
      route.sessions,
      route.users,
    );
    expect(await guard.canActivate(route.context)).toBe(true);
    expect(captcha.checked).toEqual([
      { ip: '203.0.113.7', email: 'someone@example.com', action: 'sign-in' },
    ]);
    // The body is all it reads: no session lookup.
    expect(route.tokensRead).toHaveLength(0);
  });

  it("takes the pending session's account on the second step, ignoring any email in the body", async () => {
    const captcha = fakeCaptcha();
    const route = call(
      { action: 'sign-in', count: 'failures', account: 'session' },
      {
        body: { email: 'forged@example.com' },
        cookieSession: { userId: 'u1' },
      },
    );
    const guard = new CaptchaGuard(
      new Reflector(),
      captcha.service,
      route.sessions,
      route.users,
    );
    await guard.canActivate(route.context);
    expect(captcha.checked).toEqual([
      { ip: '203.0.113.7', email: 'Pending@Example.com', action: 'sign-in' },
    ]);
    // A wrong code (a 401) keeps the attempt; a right one gives it back.
    route.response.statusCode = 401;
    route.response.emit('finish');
    expect(captcha.released).toEqual([]);
  });

  it('counts the address alone without a session, or for an account that is gone', async () => {
    for (const cookieSession of [null, { userId: 'gone' }]) {
      const captcha = fakeCaptcha();
      const route = call(
        { action: 'sign-in', count: 'failures', account: 'session' },
        { body: { code: '000000' }, cookieSession },
      );
      const guard = new CaptchaGuard(
        new Reflector(),
        captcha.service,
        route.sessions,
        route.users,
      );
      await guard.canActivate(route.context);
      expect(captcha.checked).toEqual([
        { ip: '203.0.113.7', email: undefined, action: 'sign-in' },
      ]);
      route.response.emit('finish');
      expect(captcha.released).toEqual([
        { ip: '203.0.113.7', email: undefined, action: 'sign-in' },
      ]);
    }
  });
});

describe('TokensController: the second factor and the failure counters', () => {
  const credentials = { email: 'native@example.com', password: 'secret' };

  function controller(error: Error) {
    const captcha = fakeCaptcha();
    const account = {
      issueTokens: async () => {
        throw error;
      },
    } as unknown as AccountService;
    return {
      tokens: new TokensController(
        {} as TokenService,
        account,
        captcha.service,
      ),
      released: captcha.released,
    };
  }

  it('gives the attempt back when the right password came without a code (mfa_required)', async () => {
    const { tokens, released } = controller(
      new AuthenticationError('Second factor required', {
        code: 'mfa_required',
      }),
    );
    await expect(
      tokens.issue(credentials, '198.51.100.4', undefined),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(released).toEqual([
      { ip: '198.51.100.4', email: 'native@example.com' },
    ]);
  });

  it('keeps it counted for a wrong code or recovery code, and for a wrong password', async () => {
    const wrongCode = new AuthenticationError('Invalid code', {
      code: 'mfa_required',
    });
    for (const [body, error] of [
      [{ code: '000000' }, wrongCode],
      [{ recoveryCode: 'nope' }, wrongCode],
      [{}, new AuthenticationError('Invalid credentials')],
    ] as const) {
      const { tokens, released } = controller(error);
      await expect(
        tokens.issue({ ...credentials, ...body }, '198.51.100.4', undefined),
      ).rejects.toBe(error);
      expect(released).toEqual([]);
    }
  });
});
