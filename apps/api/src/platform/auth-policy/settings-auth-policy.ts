import { Injectable } from '@nestjs/common';
import { MfaService } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  type AuthPolicySource,
  ceilingRefusal,
  sessionCeilingRefusal,
} from '../../iam/auth/auth-policy.js';
import type { IamEnv } from '../../iam/iam.env.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  AUTH_ALLOW_BREAK_GLASS,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_REQUIRE_MFA,
  AUTH_SESSION_IDLE_MINUTES,
  AUTH_SESSION_MAX_HOURS,
} from './auth-settings.js';

/**
 * IAM's `AUTH_POLICY` port, from the tenants' settings (`auth.*`,
 * auth-settings.ts). Each read runs in the tenant it is about (settings
 * are rows of their tenant, row-level security): a sign-up or a reset
 * link reads tenants the request isn't in. IAM applies the environment's
 * ceiling on top (AuthPolicyService); this refuses, when they are set,
 * values the ceiling would ignore, so an administrator learns at once.
 */
const sessionCeiling = (config: ConfigService<IamEnv, true>) => ({
  SESSION_IDLE_MINUTES: config.get('SESSION_IDLE_MINUTES', { infer: true }),
  SESSION_MAX_HOURS: config.get('SESSION_MAX_HOURS', { infer: true }),
});

@Injectable()
export class SettingsAuthPolicy implements AuthPolicySource {
  constructor(
    private readonly settings: SettingsService,
    private readonly tenancy: Tenancy,
    private readonly mfa: MfaService,
    config: ConfigService<IamEnv, true>,
  ) {
    // IAM's ceiling, on the env as it is when the value is set. Not through
    // AuthPolicyService: it injects this class (AUTH_POLICY).
    settings.restrict(AUTH_REQUIRE_MFA, (value) =>
      ceilingRefusal(
        { AUTH_MFA: config.get('AUTH_MFA', { infer: true }) },
        'requireMfa',
        value,
      ),
    );
    // The session limits may only shorten the deployment's.
    settings.restrict(AUTH_SESSION_IDLE_MINUTES, (value) =>
      sessionCeilingRefusal(
        sessionCeiling(config),
        'sessionIdleMinutes',
        value,
      ),
    );
    settings.restrict(AUTH_SESSION_MAX_HOURS, (value) =>
      sessionCeilingRefusal(sessionCeiling(config), 'sessionMaxHours', value),
    );
    // Turning it on for a scope that covers a caller who has no
    // authenticator locks that caller out of the settings they are using
    // (MfaEnrollmentGuard): refused until they enrol. Custom: the guard
    // knows the writer, `restrict()` only the value.
    settings.guardWrite(AUTH_REQUIRE_MFA, async (write) => {
      const actor = write.actor;
      if (
        write.value !== true ||
        actor.kind !== 'user' ||
        actor.impersonator ||
        !config.get('AUTH_MFA', { infer: true }) ||
        !(await this.covers(write, actor.id)) ||
        (await this.mfa.isEnrolled(actor.id))
      ) {
        return undefined;
      }
      return {
        code: 'mfa_enroll_first',
        message: t('auth.mfaEnrollFirst'),
      };
    });
  }

  /** Whether the written scope would require two-factor of this user. */
  private async covers(
    write: { scope: string; scopeId: string | undefined },
    userId: string,
  ) {
    if (write.scope === 'team') {
      return (
        write.scopeId !== undefined &&
        (await this.settings.teamsOf(userId)).includes(write.scopeId)
      );
    }
    return write.scope === 'tenant' || write.scope === 'platform';
  }

  requireMfa(user: UserPrincipal): Promise<boolean> {
    const tenantId = user.tenantId;
    if (!tenantId) {
      return Promise.resolve(false);
    }
    return this.tenancy.run(tenantId, () =>
      this.settings.anyOn(AUTH_REQUIRE_MFA, user),
    );
  }

  passwordMinLength(tenantId: string): Promise<number | undefined> {
    return this.tenancy.run(tenantId, () =>
      this.settings.get(AUTH_PASSWORD_MIN_LENGTH),
    );
  }

  sessionIdleMinutes(tenantId: string): Promise<number | undefined> {
    return this.tenancy.run(tenantId, () =>
      this.settings.get(AUTH_SESSION_IDLE_MINUTES),
    );
  }

  sessionMaxHours(tenantId: string): Promise<number | undefined> {
    return this.tenancy.run(tenantId, () =>
      this.settings.get(AUTH_SESSION_MAX_HOURS),
    );
  }

  allowsBreakGlass(tenantId: string): Promise<boolean> {
    return this.tenancy.run(tenantId, () =>
      this.settings.get(AUTH_ALLOW_BREAK_GLASS),
    );
  }
}
