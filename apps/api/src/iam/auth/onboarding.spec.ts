import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DuringOnboarding, isPlaceholderEmail } from './onboarding.js';
import { OnboardingGuard } from './onboarding.guard.js';
import type { RequestPrincipal } from './principal.js';

class Controller {
  @DuringOnboarding()
  allowed() {}
  blocked() {}
}

const user = (extra: Partial<RequestPrincipal> = {}) =>
  ({
    kind: 'user',
    id: 'u1',
    email: 'admin@example.com',
    onboarding: { email: true, password: false },
    ...extra,
  }) as RequestPrincipal;

const context = (
  handler: () => void,
  principal: RequestPrincipal | undefined,
) =>
  ({
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => ({ user: principal }) }),
  }) as unknown as ExecutionContext;

describe('isPlaceholderEmail', () => {
  it('knows the default and the reserved domains, not a real one', () => {
    for (const email of [
      'admin@example.com',
      'A@Example.ORG',
      'x@mail.test',
      'x@host.invalid',
      'x@localhost',
    ]) {
      expect(isPlaceholderEmail(email)).toBe(true);
    }
    expect(isPlaceholderEmail('owner@acme-corp.dev')).toBe(false);
    expect(isPlaceholderEmail('me@notexample.com')).toBe(false);
  });
});

describe('OnboardingGuard', () => {
  const guard = new OnboardingGuard(new Reflector());
  const run = (handler: () => void, principal?: RequestPrincipal) =>
    guard.canActivate(context(handler, principal));

  it('refuses a user mid-onboarding on a route not allowed', () => {
    expect(() => run(Controller.prototype.blocked, user())).toThrow();
  });

  it('lets the allowlisted routes through', () => {
    expect(run(Controller.prototype.allowed, user())).toBe(true);
  });

  it('never restricts others: nothing pending, clients, impersonations, no principal', () => {
    const blocked = Controller.prototype.blocked;
    expect(run(blocked, user({ onboarding: undefined }))).toBe(true);
    expect(run(blocked, { kind: 'client' } as RequestPrincipal)).toBe(true);
    expect(
      run(blocked, user({ impersonator: { id: 'a', email: 'a@b.c' } })),
    ).toBe(true);
    expect(run(blocked)).toBe(true);
  });
});
