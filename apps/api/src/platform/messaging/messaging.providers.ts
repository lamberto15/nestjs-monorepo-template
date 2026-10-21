import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { PlatformEnv } from '../platform.env.js';

type Env = CoreEnv & PlatformEnv;
import { MemoryPushProvider } from './providers/memory-push.provider.js';
import { MemorySmsProvider } from './providers/memory-sms.provider.js';
import { PUSH_PROVIDER, type PushProvider } from './providers/push-provider.js';
import { SMS_PROVIDER, type SmsProvider } from './providers/sms-provider.js';
import { ApnsPushProvider } from './providers/apns-push.provider.js';
import { CompositePushProvider } from './providers/push-composite.provider.js';
import { FcmPushProvider } from './providers/fcm-push.provider.js';
import { TwilioSmsProvider } from './providers/twilio-sms.provider.js';
import { WebPushProvider } from './providers/web-push.provider.js';

const missing = (provider: string, names: string[]) =>
  new Error(`${provider} needs ${names.join(', ')} (docs/configuration.md).`);

/**
 * The SMS provider SMS_PROVIDER names, or null while `off` (the default:
 * nothing leaves, the SMS channel is not offered). A configured provider with
 * a missing credential stops the app at start rather than failing every send.
 */
export const smsProvider: Provider = {
  provide: SMS_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SmsProvider | null => {
    const get = <K extends keyof Env>(key: K) =>
      config.get(key, { infer: true });
    switch (get('SMS_PROVIDER')) {
      case 'memory':
        return new MemorySmsProvider();
      case 'twilio': {
        const accountSid = get('TWILIO_ACCOUNT_SID');
        const authToken = get('TWILIO_AUTH_TOKEN');
        const from = get('TWILIO_FROM');
        if (!accountSid || !authToken || !from) {
          throw missing('SMS_PROVIDER=twilio', [
            'TWILIO_ACCOUNT_SID',
            'TWILIO_AUTH_TOKEN',
            'TWILIO_FROM',
          ]);
        }
        return new TwilioSmsProvider({
          accountSid,
          authToken,
          from,
          apiUrl: get('TWILIO_API_URL') ?? 'https://api.twilio.com',
          webhookUrl:
            get('TWILIO_WEBHOOK_URL') ??
            `${get('APP_URL')}/v1/webhooks/sms/twilio`,
        });
      }
      default:
        return null;
    }
  },
};

/** A PEM from an environment variable: `\n` written as two characters become newlines. */
const pem = (value: string) => value.replace(/\\n/g, '\n');

/**
 * The push providers PUSH_PROVIDER names (several serve several platforms),
 * or null while `off`. A configured provider with a missing credential stops
 * the app at start.
 */
export const pushProvider: Provider = {
  provide: PUSH_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PushProvider | null => {
    const get = <K extends keyof Env>(key: K) =>
      config.get(key, { infer: true });
    const need = <K extends keyof Env>(provider: string, names: K[]) => {
      const values = names.map((name) => get(name)) as string[];
      if (values.some((value) => !value)) {
        throw missing(`PUSH_PROVIDER=${provider}`, names as string[]);
      }
      return values;
    };
    const providers = get('PUSH_PROVIDER').map((name): PushProvider => {
      switch (name) {
        case 'memory':
          return new MemoryPushProvider();
        case 'web-push': {
          const [publicKey, privateKey, subject] = need('web-push', [
            'WEB_PUSH_VAPID_PUBLIC_KEY',
            'WEB_PUSH_VAPID_PRIVATE_KEY',
            'WEB_PUSH_SUBJECT',
          ]) as [string, string, string];
          return new WebPushProvider({ publicKey, privateKey, subject });
        }
        case 'apns': {
          const [keyId, privateKey, teamId, bundleId] = need('apns', [
            'APNS_KEY_ID',
            'APNS_PRIVATE_KEY',
            'APNS_TEAM_ID',
            'APNS_BUNDLE_ID',
          ]) as [string, string, string, string];
          return new ApnsPushProvider({
            keyId,
            privateKey: pem(privateKey),
            teamId,
            bundleId,
            apiUrl: get('APNS_API_URL') ?? 'https://api.push.apple.com',
          });
        }
        case 'fcm': {
          const [projectId, clientEmail, privateKey] = need('fcm', [
            'FCM_PROJECT_ID',
            'FCM_CLIENT_EMAIL',
            'FCM_PRIVATE_KEY',
          ]) as [string, string, string];
          return new FcmPushProvider({
            projectId,
            clientEmail,
            privateKey: pem(privateKey),
            apiUrl: get('FCM_API_URL') ?? 'https://fcm.googleapis.com',
            tokenUrl:
              get('FCM_TOKEN_URL') ?? 'https://oauth2.googleapis.com/token',
          });
        }
      }
    });
    if (providers.length === 0) return null;
    return providers.length === 1
      ? providers[0]!
      : new CompositePushProvider(providers);
  },
};
