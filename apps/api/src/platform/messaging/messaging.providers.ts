import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { PlatformEnv } from '../platform.env.js';

type Env = CoreEnv & PlatformEnv;
import { MemoryPushProvider } from './providers/memory-push.provider.js';
import { MemorySmsProvider } from './providers/memory-sms.provider.js';
import { PUSH_PROVIDER, type PushProvider } from './providers/push-provider.js';
import { SMS_PROVIDER, type SmsProvider } from './providers/sms-provider.js';
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

/** The push provider PUSH_PROVIDER names, or null while `off`. */
export const pushProvider: Provider = {
  provide: PUSH_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PushProvider | null => {
    const get = <K extends keyof Env>(key: K) =>
      config.get(key, { infer: true });
    switch (get('PUSH_PROVIDER')) {
      case 'memory':
        return new MemoryPushProvider();
      case 'web-push': {
        const publicKey = get('WEB_PUSH_VAPID_PUBLIC_KEY');
        const privateKey = get('WEB_PUSH_VAPID_PRIVATE_KEY');
        const subject = get('WEB_PUSH_SUBJECT');
        if (!publicKey || !privateKey || !subject) {
          throw missing('PUSH_PROVIDER=web-push', [
            'WEB_PUSH_VAPID_PUBLIC_KEY',
            'WEB_PUSH_VAPID_PRIVATE_KEY',
            'WEB_PUSH_SUBJECT',
          ]);
        }
        return new WebPushProvider({ publicKey, privateKey, subject });
      }
      default:
        return null;
    }
  },
};
