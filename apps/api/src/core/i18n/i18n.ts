import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  AcceptLanguageLocaleResolver,
  HeaderLocaleResolver,
  I18nModule,
  JsonI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  type LocaleResolverInput,
} from '@nestjs/i18n';
import type { Config, CoreEnv } from '../config/core.env.js';
import '../../i18n/translations.js';
import { REGIONS } from './locales.js';

/**
 * The language a signed-in user saved (`locale` on their principal): it beats
 * the browser's Accept-Language. Runs after the authentication guard.
 */
class PrincipalLocaleResolver extends LocaleResolver {
  readonly afterGuards = true;

  resolve({ executionContext }: LocaleResolverInput) {
    const request = executionContext
      ?.switchToHttp()
      .getRequest<{ user?: { locale?: string | null } | null }>();
    return request?.user?.locale ?? undefined;
  }
}

/**
 * @nestjs/i18n: messages from `src/i18n/<locale>/<namespace>.json` (copied to
 * dist by nest-cli.json), keys typed by the English catalog. The locale is
 * `?lang=`, then `X-Lang`, then the user's saved language, then
 * Accept-Language, then the first of LOCALES. Responses carry
 * `Content-Language`. Validation errors and the account emails are
 * translated; jobs and emails pass the recipient's `locale` explicitly.
 */
export const i18n = () =>
  I18nModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: Config<CoreEnv>) => {
      const locales = config.get('LOCALES', { infer: true });
      const development =
        config.get('NODE_ENV', { infer: true }) !== 'production';
      return {
        defaultLocale: locales[0],
        supportedLocales: locales,
        // Regions that keep their own formats (dates, numbers) and read the
        // base language's messages: Dubai (ar-AE), Singapore (en-SG, zh-SG, ms-SG).
        fallbacks: Object.fromEntries(
          Object.entries(REGIONS).filter(([, base]) => locales.includes(base)),
        ),
        loader: new JsonI18nLoader({
          path: join(import.meta.dirname, '../../i18n'),
          watch: config.get('NODE_ENV', { infer: true }) === 'development',
        }),
        resolvers: [
          new QueryLocaleResolver('lang'),
          new HeaderLocaleResolver('x-lang'),
          new PrincipalLocaleResolver(),
          new AcceptLanguageLocaleResolver(),
        ],
        // A missing key is a bug: fail loudly in development and tests, fall back in production.
        missingKey: development ? 'throw' : 'fallback',
      };
    },
  });
