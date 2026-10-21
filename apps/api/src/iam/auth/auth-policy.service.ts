import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MfaService } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { SingleTenant } from '../access/single-tenant.js';
import type { IamEnv } from '../iam.env.js';
import {
  AUTH_POLICY,
  type AuthPolicyCeiling,
  type AuthPolicySource,
  effectivePasswordMinLength,
  effectiveSessionLimit,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
  type SessionCeiling,
  effectiveRequireMfa,
} from './auth-policy.js';
import type { RequestPrincipal } from './principal.js';
import { UsersRepository } from './users.repository.js';

/** Whose password is being set: an account, the tenants it joins, or a self sign-up. */
export type PasswordOwner =
  { userId: string } | { tenantIds: readonly string[] } | { signUp: true };

/**
 * The auth policies as they apply (auth-policy.ts): a tenant's choices
 * (`AUTH_POLICY`, the platform's settings) under the environment's
 * ceiling, or the environment alone when nothing provides the port.
 *
 * Pre-authentication flows (sign-up, a reset link) have no tenant yet:
 * with TENANCY=multi they get the environment's policy (the floor); with
 * TENANCY=single the one tenant's choices apply to them too.
 *
 * The environment is read on every call (ConfigService), not kept: the
 * switches' tests turn AUTH_MFA off while an app runs.
 */
@Injectable()
export class AuthPolicyService {
  constructor(
    private readonly config: ConfigService<IamEnv, true>,
    private readonly mfa: MfaService,
    private readonly users: UsersRepository,
    private readonly singleTenant: SingleTenant,
    @Optional()
    @Inject(AUTH_POLICY)
    private readonly source?: AuthPolicySource,
  ) {}

  /** The environment's ceiling, now. */
  ceiling(): AuthPolicyCeiling {
    return { AUTH_MFA: this.config.get('AUTH_MFA', { infer: true }) };
  }

  /** The session lifetimes the environment allows, now. */
  sessionCeiling(): SessionCeiling {
    return {
      SESSION_IDLE_MINUTES: this.config.get('SESSION_IDLE_MINUTES', {
        infer: true,
      }),
      SESSION_MAX_HOURS: this.config.get('SESSION_MAX_HOURS', { infer: true }),
    };
  }

  /**
   * How long sessions of a tenant last, in milliseconds: the tenant's
   * choices under the environment's ceiling (`idleMs`: without a request;
   * `maxMs`: from the sign-in, however active). No tenant (or no source):
   * the ceiling. `chosen` is what the tenant itself restricted, if it did
   * (a setting left at its default is no choice): token clients' refresh
   * families, which have no idle timeout or short lifetime of their own,
   * are limited only by that.
   */
  async sessionLimits(tenantId: string | null | undefined) {
    const ceiling = this.sessionCeiling();
    const source = this.source;
    const [idle, max] =
      tenantId && source
        ? await Promise.all([
            source.sessionIdleMinutes?.(tenantId),
            source.sessionMaxHours?.(tenantId),
          ])
        : [undefined, undefined];
    const idleChosen =
      idle !== undefined && idle < SESSION_IDLE_MINUTES_LIMIT
        ? effectiveSessionLimit(ceiling.SESSION_IDLE_MINUTES, idle) * 60_000
        : undefined;
    const maxChosen =
      max !== undefined && max < SESSION_MAX_HOURS_LIMIT
        ? effectiveSessionLimit(ceiling.SESSION_MAX_HOURS, max) * 3_600_000
        : undefined;
    return {
      idleMs: idleChosen ?? ceiling.SESSION_IDLE_MINUTES * 60_000,
      maxMs: maxChosen ?? ceiling.SESSION_MAX_HOURS * 3_600_000,
      chosen: { idleMs: idleChosen, maxMs: maxChosen },
    };
  }

  /**
   * Whether the principal must set up two-factor before anything else:
   * a user (not an API client, not an impersonation: the administrator
   * signed in, not the user) whose current tenant requires it and who has
   * no confirmed authenticator. AUTH_MFA=off: never (nobody could comply).
   */
  async mfaEnrollmentRequired(principal: RequestPrincipal | null | undefined) {
    if (
      principal?.kind !== 'user' ||
      principal.impersonator ||
      !principal.tenantId ||
      !this.source ||
      !this.ceiling().AUTH_MFA
    ) {
      return false;
    }
    const required = effectiveRequireMfa(
      this.ceiling(),
      await this.source.requireMfa(principal),
    );
    return required && !(await this.mfa.isEnrolled(principal.id));
  }

  /**
   * The minimum length of a new password for its owner: the strictest of
   * the tenants an account belongs to (a password is the account's, in
   * each of them), of the tenant an invitation joins, or, for a self
   * sign-up, of the one tenant with TENANCY=single (none in multi: the
   * floor, as there is no tenant before the sign-in).
   */
  async passwordMinLength(owner: PasswordOwner): Promise<number> {
    const source = this.source;
    if (!source) {
      return effectivePasswordMinLength([]);
    }
    let tenantIds: readonly string[];
    if ('userId' in owner) {
      tenantIds = (await this.users.memberships(owner.userId)).map(
        (membership) => membership.id,
      );
    } else if ('tenantIds' in owner) {
      tenantIds = owner.tenantIds;
    } else {
      tenantIds = this.singleTenant.enabled
        ? [(await this.singleTenant.tenant()).id]
        : [];
    }
    const chosen = await Promise.all(
      tenantIds.map((tenantId) => source.passwordMinLength(tenantId)),
    );
    return effectivePasswordMinLength(chosen);
  }

  /**
   * A 400 `password_too_short` (on the field `path`) when the password is
   * shorter than its owner's tenants ask (`passwordMinLength()`). The
   * floor and the maximum are the schema's (`newPassword`).
   */
  async assertPasswordLength(
    password: string,
    path: string,
    owner: PasswordOwner,
  ) {
    const min = await this.passwordMinLength(owner);
    // Counted as the schema counts (UTF-16 code units), so both agree.
    if (password.length < min) {
      const message = t('auth.passwordTooShort', { args: { min } });
      throw new BadRequestException({
        code: 'password_too_short',
        message,
        minLength: min,
        errors: [{ path, message }],
      });
    }
  }
}
