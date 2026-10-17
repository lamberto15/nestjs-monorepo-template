import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { languages, resourcesFrom } from '@/i18n';

const modules = {
  '/src/locales/en/common.json': { hello: 'Hello' },
  '/src/locales/en/demo.json': { title: 'Demo', only: 'English only' },
  '/src/locales/de/demo.json': { title: 'Beispiel' },
  '/src/locales/ar/demo.json': { title: 'مثال' },
  '/src/locales/zh/demo.json': { title: '示例' },
  '/src/locales/ms/demo.json': { title: 'Contoh' },
};

async function instance(lng: string) {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: 'en',
    defaultNS: 'common',
    resources: resourcesFrom(modules),
  });
  return i18n;
}

describe('namespaces', () => {
  it('loads a locales/<lng>/<ns>.json file as namespace <ns>', async () => {
    const i18n = await instance('en');
    expect(i18n.t('hello')).toBe('Hello');
    expect(i18n.t('title', { ns: 'demo' })).toBe('Demo');
  });

  it.each(languages.filter((l) => l !== 'en'))(
    '%s falls back to en for a missing key',
    async (lng) => {
      const i18n = await instance(lng);
      expect(i18n.t('title', { ns: 'demo' })).not.toBe('Demo');
      expect(i18n.t('only', { ns: 'demo' })).toBe('English only');
    },
  );

  it('loads the real nav namespace in every language', () => {
    const files = import.meta.glob<Record<string, unknown>>(
      '@/locales/*/nav.json',
      {
        eager: true,
        import: 'default',
      },
    );
    expect(Object.keys(resourcesFrom(files)).toSorted()).toEqual(
      [...languages].toSorted(),
    );
  });
});
