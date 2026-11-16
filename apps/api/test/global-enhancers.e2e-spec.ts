import { ApplicationConfig } from '@nestjs/core/application-config.js';
import { AppModule } from '../src/app.module.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The app's global enhancers, in the order Nest runs them. Nest orders them
 * by module (app.module.ts's imports, depth first, a module's own providers
 * before its imports') and then by provider: reordering those imports, or
 * moving an APP_GUARD / APP_INTERCEPTOR / APP_PIPE / APP_FILTER to another
 * module, changes this order and fails here.
 */
describe('global enhancers (e2e)', () => {
  let node: TestApp;
  let config: ApplicationConfig;

  beforeAll(async () => {
    node = await bootApp(undefined, undefined, { module: AppModule });
    config = node.app.get(ApplicationConfig);
  });
  afterAll(async () => {
    await node.close();
  });

  const names = (enhancers: object[]) =>
    enhancers.map((enhancer) => enhancer.constructor.name);

  it('runs the guards in order', () => {
    expect(names(config.getGlobalGuards())).toEqual([
      // PlatformModule's (first in app.module.ts): read-only and maintenance
      // refuse a write before anything counts or authenticates it.
      'ModeGuard',
      // CoreModule's, before IamModule's: guessed credentials count toward
      // the rate limit, so it runs before authentication.
      'AppThrottlerGuard',
      // nestjs-cls's (ClsModule.forRoot in CoreModule), a factory's plain
      // object: the request's context is the middleware's, opened before any guard.
      'Object',
      // IamModule's own, before its imports': authentication sets the principal.
      'PrincipalGuard',
      // On the principal, before authorization: a user who must enroll in
      // two-factor reaches only the enrollment routes.
      'MfaEnrollmentGuard',
      // The first administrator's onboarding, before authorization.
      'OnboardingGuard',
      // "SSO required", on the principal's own session and tenant: before a
      // break-glass grant moves the request to another tenant.
      'SsoRequiredGuard',
      // Moves the request to the tenant a break-glass grant opened, read only:
      // before authorization decides in that tenant.
      'BreakGlassGuard',
      // Last (AuthorizationModule, imported by IamModule): decides on the
      // final principal and tenant.
      'AuthorizationGuard',
    ]);
  });

  it('runs the interceptors in order', () => {
    expect(names(config.getGlobalInterceptors())).toEqual([
      // Outermost (IdempotencyModule, PlatformModule's first import): a
      // replay doesn't pass through the interceptors below again.
      'IdempotencyInterceptor',
      // USAGE=on (the tests' default): UsageModule's, PlatformModule's second
      // import. It meters a client call the handler runs for, not a replay;
      // the principal it meters is the guards', which all ran before it.
      'UsageInterceptor',
      // ResilienceModule (integrations() in PlatformModule): a route's retries
      // and timeouts, outside the authentication scope below, which each
      // attempt opens again.
      'ResilienceInterceptor',
      // nestjs-cls's (CoreModule), a factory's plain object: not mounted for
      // HTTP, whose context is the middleware's.
      'Object',
      // The request's language (CoreModule's I18nModule), for the
      // messages of the interceptors and handler inside it.
      'I18nInterceptor',
      // AuthenticationModule's (imported by IamModule): opens the authentication
      // scope the guard recorded, around the handler and every retry of it.
      'AuthenticationScopeInterceptor',
      // Innermost (AuthorizationModule): an AuthorizationError a service
      // throws becomes the same response @Can() gives.
      'AuthorizationErrorInterceptor',
    ]);
  });

  it('validates with one pipe and answers errors with one filter', () => {
    // CoreModule's: every @Body/@Query schema, with messages in the request's language.
    expect(names(config.getGlobalPipes())).toEqual([
      'I18nStandardSchemaValidationPipe',
    ]);
    // CoreModule's: every error as RFC 9457 problem details.
    expect(names(config.getGlobalFilters())).toEqual(['ProblemDetailsFilter']);
  });
});
