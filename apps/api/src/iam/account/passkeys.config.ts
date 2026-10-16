import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import type { Config } from '../../core/config/core.env.js';
import type { IamEnv } from '../iam.env.js';

/** The variables the relying party is built from. */
export type PasskeyEnv = Pick<
  IamEnv & CoreEnv,
  | 'NODE_ENV'
  | 'APP_URL'
  | 'WEB_URL'
  | 'SERVICE_NAME'
  | 'PASSKEYS'
  | 'PASSKEY_RP_ID'
  | 'PASSKEY_RP_NAME'
  | 'PASSKEY_ORIGINS'
  | 'PASSKEY_CHALLENGE_TTL_SECONDS'
  | 'PASSKEY_ANDROID_APPS'
  | 'PASSKEY_APPLE_APPS'
>;

/** The relying party: what every ceremony is checked against. */
export interface PasskeySettings {
  enabled: boolean;
  /** The RP ID: the web app's registrable domain. */
  rpId: string;
  rpName: string;
  /** The origins a ceremony's `clientDataJSON.origin` may name. */
  origins: string[];
  challengeTtlSeconds: number;
  androidApps: { packageName: string; fingerprint: string }[];
  appleApps: string[];
}

/** An Android app's FIDO origin: `android:apk-key-hash:` + base64url of its signing certificate's SHA-256 (the fingerprint's bytes). */
export const androidOrigin = (fingerprint: string) =>
  `android:apk-key-hash:${Buffer.from(fingerprint.replace(/:/g, ''), 'hex').toString('base64url')}`;

const hostOf = (url: string | undefined) =>
  url ? new URL(url).hostname : undefined;
const originOf = (url: string | undefined) =>
  url ? new URL(url).origin : undefined;

/** The relying party from the validated environment (env.ts): the same in every process. */
export function passkeySettings(env: PasskeyEnv): PasskeySettings {
  const web = env.WEB_URL ?? env.APP_URL;
  const androidApps = env.PASSKEY_ANDROID_APPS.map((app) => {
    const [packageName, ...fingerprint] = app.split(':');
    return {
      packageName: packageName!,
      fingerprint: fingerprint.join(':').toUpperCase(),
    };
  });
  return {
    enabled: env.PASSKEYS,
    rpId: (env.PASSKEY_RP_ID ?? hostOf(web)!).toLowerCase(),
    rpName: env.PASSKEY_RP_NAME ?? env.SERVICE_NAME,
    origins: [
      ...new Set([
        originOf(web)!,
        ...env.PASSKEY_ORIGINS,
        ...androidApps.map((app) => androidOrigin(app.fingerprint)),
      ]),
    ],
    challengeTtlSeconds: env.PASSKEY_CHALLENGE_TTL_SECONDS,
    androidApps,
    appleApps: env.PASSKEY_APPLE_APPS,
  };
}

/** `passkeySettings()` from ConfigService (services and controllers). */
export const passkeySettingsOf = (config: Config<IamEnv & CoreEnv>) =>
  passkeySettings({
    NODE_ENV: config.get('NODE_ENV', { infer: true }),
    APP_URL: config.get('APP_URL', { infer: true }),
    WEB_URL: webUrl(config),
    SERVICE_NAME: config.get('SERVICE_NAME', { infer: true }),
    PASSKEYS: config.get('PASSKEYS', { infer: true }),
    PASSKEY_RP_ID: config.get('PASSKEY_RP_ID', { infer: true }),
    PASSKEY_RP_NAME: config.get('PASSKEY_RP_NAME', { infer: true }),
    PASSKEY_ORIGINS: config.get('PASSKEY_ORIGINS', { infer: true }),
    PASSKEY_CHALLENGE_TTL_SECONDS: config.get('PASSKEY_CHALLENGE_TTL_SECONDS', {
      infer: true,
    }),
    PASSKEY_ANDROID_APPS: config.get('PASSKEY_ANDROID_APPS', { infer: true }),
    PASSKEY_APPLE_APPS: config.get('PASSKEY_APPLE_APPS', { infer: true }),
  });

/** An IPv4 address, or an IPv6 one (it has a colon: `cafe` is a host name). */
const IP_ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f]*:[0-9a-f:.]*\]?)$/i;

/** Whether `host` is the RP ID or a host under it (`app.example.com` under `example.com`). */
export const underRpId = (host: string, rpId: string) =>
  host === rpId || host.endsWith(`.${rpId}`);

/**
 * What is wrong with the passkey configuration, as `[variable, message]`
 * pairs; empty when it is consistent. Every environment: an origin that
 * isn't a URL, or one whose host isn't under the RP ID (a browser would
 * refuse the ceremony, and every credential made would be useless).
 * Production only: an RP ID of `localhost` or an address, and origins that
 * aren't `https://` (WebAuthn allows plain http for localhost alone). Off
 * (PASSKEYS=off), nothing is checked. Checked at boot (env.ts), since the
 * RP ID never changes once a credential exists.
 */
export function passkeyEnvIssues(env: PasskeyEnv): [string, string][] {
  if (!env.PASSKEYS) {
    return [];
  }
  const issues: [string, string][] = [];
  const settings = passkeySettings(env);
  const production = env.NODE_ENV === 'production';
  if (
    production &&
    (settings.rpId === 'localhost' || IP_ADDRESS.test(settings.rpId))
  ) {
    issues.push([
      'PASSKEY_RP_ID',
      `"${settings.rpId}" is not a domain: set PASSKEY_RP_ID (or WEB_URL) to the web app's domain`,
    ]);
  }
  for (const origin of settings.origins) {
    if (origin.startsWith('android:apk-key-hash:')) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      issues.push(['PASSKEY_ORIGINS', `"${origin}" is not a URL`]);
      continue;
    }
    if (url.origin !== origin) {
      issues.push([
        'PASSKEY_ORIGINS',
        `"${origin}" is not an origin (scheme://host[:port], no path)`,
      ]);
    }
    if (production && url.protocol !== 'https:') {
      issues.push([
        'PASSKEY_ORIGINS',
        `"${origin}" is not https: passkeys only work on secure origins`,
      ]);
    }
    if (!underRpId(url.hostname.toLowerCase(), settings.rpId)) {
      issues.push([
        'PASSKEY_RP_ID',
        `origin "${origin}" is not under the RP ID "${settings.rpId}": set PASSKEY_RP_ID to a domain every origin shares`,
      ]);
    }
  }
  return issues;
}
