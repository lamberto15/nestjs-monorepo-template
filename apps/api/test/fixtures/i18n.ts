import { join } from 'node:path';
import { I18nLoader, JsonI18nLoader } from '@nestjs/i18n';

type Catalog = Record<string, unknown>;

/** `extra` into `base`, key by key: the fixtures only add keys. */
function merge(base: Catalog, extra: Catalog): Catalog {
  const out: Catalog = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      current &&
      typeof current === 'object' &&
      value &&
      typeof value === 'object'
        ? merge(current as Catalog, value as Catalog)
        : value;
  }
  return out;
}

/**
 * The app's catalogs (src/i18n) and the test-only features' texts
 * (test/fixtures/i18n), merged: what the tests boot with (support.ts
 * bootApp, through the I18nLoader token @nestjs/i18n offers for tests), so
 * the app's catalogs never carry a test feature's keys.
 */
export class FixtureI18nLoader extends I18nLoader {
  private readonly app = new JsonI18nLoader({
    path: join(import.meta.dirname, '../../src/i18n'),
  });
  private readonly fixtures = new JsonI18nLoader({
    path: join(import.meta.dirname, 'i18n'),
  });

  async load() {
    const [app, fixtures] = await Promise.all([
      this.app.load(),
      this.fixtures.load(),
    ]);
    return merge(app, fixtures) as Awaited<ReturnType<I18nLoader['load']>>;
  }
}
