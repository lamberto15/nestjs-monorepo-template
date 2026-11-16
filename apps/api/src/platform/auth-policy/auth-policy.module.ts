import { Module } from '@nestjs/common';
import { SettingsAuthPolicy } from './settings-auth-policy.js';
import { AUTH_POLICY } from '../../iam/auth/auth-policy.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * The auth-policy capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [SettingsModule],
  providers: [
    // IAM's auth policies (iam can't import the platform): the tenants'
    // auth.* settings, which IAM reads under the env's ceiling.
    SettingsAuthPolicy,
    { provide: AUTH_POLICY, useExisting: SettingsAuthPolicy },
  ],
  exports: [AUTH_POLICY],
})
export class AuthPolicyModule {}
