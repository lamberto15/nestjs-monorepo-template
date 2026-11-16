import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getHttpClientToken,
  type HttpClient,
  HttpClientModule,
  type HttpRetryOptions,
} from '@nestjs/http-client';
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

/** The @nestjs/http-client clients of the providers (the platform registers them). */
export const TWILIO_HTTP = 'twilio';
export const FCM_HTTP = 'fcm';
export const FCM_TOKEN_HTTP = 'fcm-token';

/** The token URL split for @nestjs/http-client: its origin, and the path to post to. */
export const tokenEndpoint = (url: string) => {
  const parsed = new URL(url);
  return { baseUrl: parsed.origin, path: parsed.pathname };
};

/**
 * Twilio's and FCM's clients: the base URLs come from TWILIO_API_URL,
 * FCM_API_URL and FCM_TOKEN_URL; a 10 s limit per attempt, as before. A send
 * is never retried blindly (a POST is not, by default): the queue retries a
 * transient failure with its backoff, and Twilio's idempotency token dedupes
 * it. The one retry here is a 429, a request the provider did not take, which
 * waits out its `Retry-After` (up to 5 s; a longer one goes to the queue). The
 * token exchange has no side effect: it may be retried on any transient failure.
 * APNs is not here: it needs HTTP/2 (apns-push.provider.ts).
 */
export const messagingClients = () => {
  const rateLimited: HttpRetryOptions = {
    attempts: 2,
    methods: ['POST'],
    statusCodes: [429],
    backoff: { delay: '1s', maxDelay: '5s' },
  };
  return [
    HttpClientModule.registerAsync({
      name: TWILIO_HTTP,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        baseUrl: config.get('TWILIO_API_URL', { infer: true }),
        timeout: '10s',
        retry: rateLimited,
      }),
    }),
    HttpClientModule.registerAsync({
      name: FCM_HTTP,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        baseUrl: config.get('FCM_API_URL', { infer: true }),
        timeout: '10s',
        retry: rateLimited,
      }),
    }),
    HttpClientModule.registerAsync({
      name: FCM_TOKEN_HTTP,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        baseUrl: tokenEndpoint(config.get('FCM_TOKEN_URL', { infer: true }))
          .baseUrl,
        timeout: '10s',
        retry: { attempts: 3, methods: ['POST'] },
      }),
    }),
  ];
};

const missing = (provider: string, names: string[]) =>
  new Error(`${provider} needs ${names.join(', ')} (docs/configuration.md).`);

/**
 * The SMS provider SMS_PROVIDER names, or null while `off` (the default:
 * nothing leaves, the SMS channel is not offered). A configured provider with
 * a missing credential stops the app at start rather than failing every send.
 */
export const smsProvider: Provider = {
  provide: SMS_PROVIDER,
  inject: [ConfigService, getHttpClientToken(TWILIO_HTTP)],
  useFactory: (
    config: ConfigService<Env, true>,
    http: HttpClient,
  ): SmsProvider | null => {
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
        return new TwilioSmsProvider(
          {
            accountSid,
            authToken,
            from,
            webhookUrl:
              get('TWILIO_WEBHOOK_URL') ??
              `${get('APP_URL')}/v1/webhooks/sms/twilio`,
          },
          http,
        );
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
  inject: [
    ConfigService,
    getHttpClientToken(FCM_HTTP),
    getHttpClientToken(FCM_TOKEN_HTTP),
  ],
  useFactory: (
    config: ConfigService<Env, true>,
    fcmHttp: HttpClient,
    tokenHttp: HttpClient,
  ): PushProvider | null => {
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
          const tokenUrl =
            get('FCM_TOKEN_URL') ?? 'https://oauth2.googleapis.com/token';
          return new FcmPushProvider(
            {
              projectId,
              clientEmail,
              privateKey: pem(privateKey),
              tokenUrl,
              tokenPath: tokenEndpoint(tokenUrl).path,
            },
            fcmHttp,
            tokenHttp,
          );
        }
      }
    });
    if (providers.length === 0) return null;
    return providers.length === 1
      ? providers[0]!
      : new CompositePushProvider(providers);
  },
};
