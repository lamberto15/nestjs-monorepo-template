import { randomBytes } from 'node:crypto';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthenticationModule } from '@nestjs/authentication';
import { AuthorizationModule } from '@nestjs/authorization';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { getDrizzleToken } from '@nestjs/drizzle';
import {
  getHttpClientToken,
  type HttpClient,
  HttpClientModule,
} from '@nestjs/http-client';
import { type CoreEnv, webUrl } from '../core/config/core.env.js';
import { loadOrCreateSecret, type Database } from '../core/database/drizzle.js';
import { AccessAdminService } from './access/access-admin.service.js';
import { AccessController } from './access/access.controller.js';
import { AccessSeeder } from './access/access.seeder.js';
import { AccessService } from './access/access.service.js';
import { TeamsController } from './access/teams.controller.js';
import { TeamsService } from './access/teams.service.js';
import { ApiClientsService } from './access/api-clients.service.js';
import { PrincipalsService } from './access/principals.service.js';
import { PermissionCatalog } from './access/permission-catalog.js';
import { AccessPolicy } from './access/policies.js';
import { SystemContext } from './access/system-context.js';
import {
  TenantsController,
  TenantSwitchController,
} from './access/tenants.controller.js';
import { SignUpTenant } from './access/sign-up-tenant.js';
import { SignUpTenantSweepJob } from './access/sign-up-tenant-sweep.job.js';
import { SingleTenant } from './access/single-tenant.js';
import { TenantsService } from './access/tenants.service.js';
import { TenantSwitchService } from './access/tenant-switch.service.js';
import { InvitationsService } from './access/invitations.service.js';
import { OperatorGuard } from './auth/operator-only.js';
import {
  EmailVerificationMailer,
  MagicLinkMailer,
  OidcAccounts,
  PasswordResetMailer,
} from './account/account.handlers.js';
import {
  InvitationMail,
  MagicLinkMail,
  TenantInvitationMail,
  ResetPasswordMail,
  VerifyEmailMail,
} from './account/account.mails.js';
import {
  BreachedPasswordsService,
  PWNED_PASSWORDS,
} from './account/breached-passwords.service.js';
import { CredentialsService } from './account/credentials.service.js';
import { SignInPasswordCheck } from './account/sign-in-password-check.js';
import {
  boundedPasswordHasher,
  PASSWORD_HASHER_PARAMS,
  PasswordHashLimiter,
  passwordHashingProviders,
} from './account/password-hashing.js';
import { CAPTCHA_VERIFIER } from './captcha/captcha-verifier.js';
import { CaptchaGuard } from './captcha/captcha.guard.js';
import {
  type CaptchaEnv,
  createCaptchaVerifier,
  verifyEndpoint,
} from './captcha/captcha.providers.js';
import { CaptchaService } from './captcha/captcha.service.js';
import { TURNSTILE_HTTP } from './captcha/turnstile.verifier.js';
import { EmailController } from './account/email.controller.js';
import { SoftDeletePurgeJob } from './resources/soft-delete-purge.job.js';
import { RecordPurgeRegistry } from './resources/record-purge.registry.js';
import { UserLifecycleRegistry } from './auth/user-lifecycle.registry.js';
import { ApiClientLifecycleRegistry } from './access/api-client-lifecycle.registry.js';
import { ApiClientCountsRegistry } from './access/api-client-counts.registry.js';
import { TenantLifecycleRegistry } from './access/tenant-lifecycle.registry.js';
import { SignInContext, signInMetadata } from './auth/sign-in-context.js';
import { ProviderReauthentications } from './account/oidc-reauthentication.js';
import { AccountService } from './account/account.service.js';
import { ImpersonationService } from './account/impersonation.service.js';
import { SecurityAlertsService } from './account/security-alerts.service.js';
import { MagicLinkController } from './account/magic-link.controller.js';
import { MfaController } from './account/mfa.controller.js';
import { OidcController } from './account/oidc.controller.js';
import { PasskeysController } from './account/passkeys.controller.js';
import {
  passkeyDecoyKeyProvider,
  PasskeysService,
} from './account/passkeys.service.js';
import { WellKnownController } from './account/well-known.controller.js';
import { oidcProviders } from './account/oidc.providers.js';
import { PasswordController } from './account/password.controller.js';
import { ReauthenticationController } from './account/reauthentication.controller.js';
import { ReauthenticationService } from './account/reauthentication.service.js';
import { SessionsController } from './account/sessions.controller.js';
import { TokensController } from './account/tokens.controller.js';
import { AuditRetentionJob } from './audit/audit-retention.job.js';
import { AuditService } from './audit/audit.service.js';
import { ApiKeyAuth } from './auth/api-key-auth.provider.js';
import { AuthController } from './auth/auth.controller.js';
import './auth/auth-types.js';
import { DrizzleAuthenticationStore } from './auth/drizzle-authentication.store.js';
import { JwtAuth } from './auth/jwt-auth.provider.js';
import { PrincipalGuard } from './auth/principal.guard.js';
import { AuthPolicyService } from './auth/auth-policy.service.js';
import { MfaEnrollmentGuard } from './auth/mfa-enrollment.guard.js';
import { SessionAuth } from './auth/session-auth.provider.js';
import { UsersRepository } from './auth/users.repository.js';
import type { IamEnv } from './iam.env.js';
import { IAM_OPTIONS, type IamOptions } from './iam.options.js';

const random256 = () => randomBytes(32).toString('base64url');

/**
 * Identity and access: who is calling, what they may do, and who did what.
 *
 * - Sign-in: password (browser session or tokens for mobile apps), magic
 *   link, passkeys, Google / Microsoft / GitHub, with TOTP two-factor and recovery
 *   codes; sign-up when open, invitations, email verification, forgot /
 *   reset / change password, sessions and sign-out everywhere.
 * - API clients by key; support impersonation, audited.
 * - Roles of CASL permissions (the access API) and the audit log.
 *
 * Everything @nestjs/authentication keeps is in PostgreSQL
 * (DrizzleAuthenticationStore), so any number of instances share it.
 * The other groups and the features declare their permissions with
 * `definePermissions()` and hand them over here, so IAM never imports them:
 *
 * ```ts
 * IamModule.forRoot({ permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS] })
 * ```
 *
 * Global: features inject AccessService, AuditService and the auth providers.
 */
@Module({})
export class IamModule {
  static forRoot(options: IamOptions): DynamicModule {
    const exported = [
      AccessService,
      // The demo seed (src/demo) creates its users through it.
      AccessAdminService,
      AuditService,
      PermissionCatalog,
      SessionAuth,
      ApiKeyAuth,
      JwtAuth,
      AccessPolicy,
      UsersRepository,
      TeamsService,
      // Step-up (@RecentAuthentication()) on the routes of every group; a
      // person's own account (platform/account) checks their password again.
      ReauthenticationService,
      CredentialsService,
      // The platform's data about records goes with them when they are purged.
      RecordPurgeRegistry,
      UserLifecycleRegistry,
      ApiClientLifecycleRegistry,
      ApiClientCountsRegistry,
      TenantLifecycleRegistry,
      // Work without a user runs as the system principal (seeds, cron jobs, workflows).
      SystemContext,
      // Tenants (docs/tenancy.md): the operators' routes and the tests make them.
      TenantsService,
      SingleTenant,
      OperatorGuard,
      // Global, so AuthenticationModule's PasswordHasher (below) reaches them.
      PasswordHashLimiter,
      PASSWORD_HASHER_PARAMS,
      // The auth policies as they apply (the platform's and the features' routes may ask).
      AuthPolicyService,
    ];
    return {
      module: IamModule,
      global: true,
      imports: [
        // Every route needs a signed-in principal unless it's @Public(). The
        // global guard is PrincipalGuard (below): the package's, refusing the
        // system principal.
        withBoundedPasswordHasher(
          AuthenticationModule.forRootAsync({
            globalGuard: false,
            inject: [ConfigService, getDrizzleToken(), ClsService],
            useFactory: async (
              config: ConfigService<IamEnv & CoreEnv, true>,
              db: Database,
              cls: ClsService,
            ) => {
              const web = webUrl(config);
              const api = config.get('APP_URL', { infer: true });
              const providers = oidcProviders(config);
              const origins = config.get('CORS_ORIGINS', { infer: true });
              // Off only for tests over plain HTTP; applies to every cookie the module sets.
              const cookie = {
                secure: config.get('SESSION_COOKIE_SECURE', { infer: true }),
              };
              return {
                session: {
                  absoluteTtl: '12h', // a user session ends after a working day
                  idleTtl: '2h', // or after two hours without a request
                  // Without Secure (tests only), the cookie is named "sid", not "__Host-sid".
                  cookie,
                  // The web app on another origin may use the cookie (same list as CSRF).
                  trustedOrigins: origins,
                  // What the session keeps of the request: a new-device check
                  // reads it from the sign-in event (SecurityAlertsService).
                  // Every sign-in (password, link, provider) passes here, so
                  // this is where its method and time are recorded (step-up:
                  // ReauthenticationService): from the sign-in under way
                  // (SignInContext), else now.
                  metadata: (request: {
                    headers: Record<string, unknown>;
                    ip?: string;
                  }) => ({
                    userAgent: request.headers['user-agent'],
                    ip: request.ip,
                    ...signInMetadata(cls),
                  }),
                },
                // TOTP secrets encrypted at rest (AES-256-GCM), newest key first.
                mfa: {
                  encryption: {
                    keys: (
                      await loadOrCreateSecret(
                        db,
                        'MFA_ENCRYPTION_KEYS',
                        random256,
                      )
                    ).split(','),
                  },
                  issuer:
                    config.get('MFA_ISSUER', { infer: true }) ??
                    config.get('SERVICE_NAME', { infer: true }),
                },
                // Access tokens for mobile apps and CLIs (POST /auth/token), with refresh tokens.
                accessToken: {
                  key: await loadOrCreateSecret(db, 'JWT_SECRET', random256),
                  issuer: api,
                  audience: config.get('SERVICE_NAME', { infer: true }),
                  ttl: '15m',
                },
                // The pages of the web app the emails link to; each POSTs the token back.
                passwordReset: { url: `${web}/reset-password` },
                emailVerification: { url: `${web}/verify-email` },
                ...(config.get('AUTH_MAGIC_LINK', { infer: true }) && {
                  magicLink: { url: `${web}/magic-link`, cookie },
                }),
                ...(Object.keys(providers).length > 0 && {
                  oidc: {
                    callbackUrl: `${api}/v1/auth/oidc/:provider/callback`,
                    providers,
                    redirectAfterLogin: `${web}/`,
                    cookie,
                  },
                }),
              };
            },
          }),
        ),
        // Denies by default: a route runs only with @Can(), @Can.Anyone() or @Public().
        AuthorizationModule.forRoot(),
        // Pwned Passwords (BreachedPasswordsService): the app-wide defaults
        // (user-agent, which the API requires) come from the platform's
        // HttpClientModule.forRootAsync(). One short attempt, no retries:
        // the user waits on it, and PASSWORD_BREACH_ON_ERROR decides the rest.
        HttpClientModule.registerAsync({
          name: PWNED_PASSWORDS,
          inject: [ConfigService],
          useFactory: (config: ConfigService<IamEnv, true>) => ({
            baseUrl: config.get('PASSWORD_BREACH_API_URL', { infer: true }),
            timeout: config.get('PASSWORD_BREACH_TIMEOUT_MS', { infer: true }),
            retry: false,
          }),
        }),
        // The challenge provider's siteverify endpoint (TurnstileVerifier):
        // the same shape, the timeout and breaker come from CaptchaService.
        HttpClientModule.registerAsync({
          name: TURNSTILE_HTTP,
          inject: [ConfigService],
          useFactory: (config: ConfigService<IamEnv, true>) => ({
            baseUrl: verifyEndpoint(
              config.get('CAPTCHA_VERIFY_URL', { infer: true }),
            ).baseUrl,
            timeout: config.get('CAPTCHA_TIMEOUT_MS', { infer: true }),
            retry: false,
          }),
        }),
      ],
      controllers: [
        AuthController,
        PasswordController,
        EmailController,
        SessionsController,
        MfaController,
        MagicLinkController,
        OidcController,
        TokensController,
        ReauthenticationController,
        PasskeysController,
        WellKnownController,
        AccessController,
        TeamsController,
        TenantSwitchController,
        TenantsController,
      ],
      providers: [
        { provide: IAM_OPTIONS, useValue: options },
        // The authentication guard: this module's providers come before its
        // imports (AuthorizationModule's guard) in Nest's order.
        { provide: APP_GUARD, useClass: PrincipalGuard },
        // Right after it, before authorization: a user their tenant requires
        // two-factor of, without one, reaches only the enrollment routes
        // (auth.requireMfa, docs/auth.md "Policies").
        { provide: APP_GUARD, useClass: MfaEnrollmentGuard },
        // The auth policies: the platform's settings (AUTH_POLICY) under the env's ceiling.
        AuthPolicyService,
        // Authentication: the credential providers and the store of everything they keep.
        DrizzleAuthenticationStore,
        SessionAuth,
        ApiKeyAuth,
        JwtAuth,
        UsersRepository,
        CredentialsService,
        BreachedPasswordsService,
        // Sign-in passwords against the breaches, off the sign-in's path.
        SignInPasswordCheck,
        // At most PASSWORD_HASH_CONCURRENCY password hashes at once (password-hashing.ts).
        ...passwordHashingProviders,
        // Bot protection on the public routes (@Captcha()): the verifier
        // CAPTCHA_PROVIDER names, checked at startup (keys, never the stub in production).
        {
          provide: CAPTCHA_VERIFIER,
          inject: [ConfigService, getHttpClientToken(TURNSTILE_HTTP)],
          useFactory: (
            config: ConfigService<IamEnv & CoreEnv, true>,
            http: HttpClient,
          ) => {
            const pick = <K extends keyof CaptchaEnv>(key: K) =>
              config.get(key, { infer: true }) as CaptchaEnv[K];
            return createCaptchaVerifier(
              {
                NODE_ENV: pick('NODE_ENV'),
                APP_ENV: pick('APP_ENV'),
                CAPTCHA_MODE: pick('CAPTCHA_MODE'),
                CAPTCHA_PROVIDER: pick('CAPTCHA_PROVIDER'),
                CAPTCHA_VERIFY_URL: pick('CAPTCHA_VERIFY_URL'),
                TURNSTILE_SITE_KEY: pick('TURNSTILE_SITE_KEY'),
                TURNSTILE_SECRET_KEY: pick('TURNSTILE_SECRET_KEY'),
              },
              http,
            );
          },
        },
        CaptchaService,
        CaptchaGuard,
        // Accounts: what the package asks of the app (mail, users), and the emails.
        PasswordResetMailer,
        EmailVerificationMailer,
        MagicLinkMailer,
        OidcAccounts,
        ResetPasswordMail,
        InvitationMail,
        TenantInvitationMail,
        VerifyEmailMail,
        MagicLinkMail,
        ImpersonationService,
        AccountService,
        // How each session was created, and step-up.
        SignInContext,
        // Step-ups through a provider under way (prompt=login, auth_time).
        ProviderReauthentications,
        ReauthenticationService,
        // Passkeys (WebAuthn): registration, sign-in, re-authentication.
        PasskeysService,
        passkeyDecoyKeyProvider,
        // Security notifications (IAM_NOTIFICATIONS), sent through the platform's IAM_NOTIFIER.
        SecurityAlertsService,
        // Authorization: the catalog, the CASL abilities, their admin, the audit log.
        PermissionCatalog,
        AccessService,
        AccessAdminService,
        TeamsService,
        ApiClientsService,
        PrincipalsService,
        AccessSeeder,
        TenantsService,
        SingleTenant,
        SignUpTenant,
        TenantSwitchService,
        InvitationsService,
        OperatorGuard,
        AuditService,
        SystemContext,
        AuditRetentionJob,
        SoftDeletePurgeJob,
        SignUpTenantSweepJob,
        RecordPurgeRegistry,
        UserLifecycleRegistry,
        ApiClientLifecycleRegistry,
        ApiClientCountsRegistry,
        TenantLifecycleRegistry,
        AccessPolicy,
      ],
      exports: exported,
    };
  }
}

/**
 * AuthenticationModule with its PasswordHasher replaced by the bounded one
 * (password-hashing.ts), so the package's own services (sign-in, password
 * reset) share the app's hashing limit. The package has no hasher option;
 * a dynamic module's providers register after the module's own, so this
 * one takes the token. The e2e tests check the instance (password-hashing.e2e-spec.ts).
 */
function withBoundedPasswordHasher(module: DynamicModule): DynamicModule {
  return {
    ...module,
    providers: [...(module.providers ?? []), boundedPasswordHasher],
  };
}
