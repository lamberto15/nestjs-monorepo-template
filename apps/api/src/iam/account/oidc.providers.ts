import {
  github,
  google,
  microsoft,
  type OidcProviderConfig,
} from '@nestjs/authentication';
import type { Config } from '../../core/config/core.env.js';
import type { IamEnv } from '../iam.env.js';

/** The OAuth / OpenID Connect providers whose credentials are set, by name. */
export function oidcProviders(
  config: Config<IamEnv>,
): Record<string, OidcProviderConfig> {
  const get = (name: keyof IamEnv) =>
    config.get(name, { infer: true }) as string | undefined;
  const providers: Record<string, OidcProviderConfig> = {};
  const googleId = get('GOOGLE_CLIENT_ID');
  const googleSecret = get('GOOGLE_CLIENT_SECRET');
  if (googleId && googleSecret) {
    providers.google = google({
      clientId: googleId,
      clientSecret: googleSecret,
    });
  }
  const tenant = get('MICROSOFT_TENANT_ID');
  const msId = get('MICROSOFT_CLIENT_ID');
  const msSecret = get('MICROSOFT_CLIENT_SECRET');
  if (tenant && msId && msSecret) {
    providers.microsoft = microsoft({
      tenant,
      clientId: msId,
      clientSecret: msSecret,
    });
  }
  const githubId = get('GITHUB_CLIENT_ID');
  const githubSecret = get('GITHUB_CLIENT_SECRET');
  if (githubId && githubSecret) {
    providers.github = github({
      clientId: githubId,
      clientSecret: githubSecret,
    });
  }
  return providers;
}
