import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  type AuthPolicySource,
  ceilingRefusal,
} from '../../iam/auth/auth-policy.js';
import type { IamEnv } from '../../iam/iam.env.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  AUTH_ALLOW_BREAK_GLASS,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_REQUIRE_MFA,
} from './auth-settings.js';

/**
 * IAM's `AUTH_POLICY` port, from the tenants' settings (`auth.*`,
 * auth-settings.ts). Each read runs in the tenant it is about (settings
 * are rows of their tenant, row-level security): a sign-up or a reset
 * link reads tenants the request isn't in. IAM applies the environment's
 * ceiling on top (AuthPolicyService); this refuses, when they are set,
 * values the ceiling would ignore, so an administrator learns at once.
 */
@Injectable()
export class SettingsAuthPolicy implements AuthPolicySource {
  constructor(
    private readonly settings: SettingsService,
    private readonly tenancy: Tenancy,
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

  allowsBreakGlass(tenantId: string): Promise<boolean> {
    return this.tenancy.run(tenantId, () =>
      this.settings.get(AUTH_ALLOW_BREAK_GLASS),
    );
  }
}
