import { beforeAll, describe, expect, it } from 'vitest';
import en from '@/locales/en/nav.json';
import de from '@/locales/de/nav.json';
import ar from '@/locales/ar/nav.json';
import { initI18n } from '@/i18n';

// The real catalogs, through the real backend: `en` is in memory, the stored
// language is loaded before initI18n resolves, and a switch loads the new
// language before it happens.
const key = 'groups.workspace';
const text = (catalog: typeof en) => catalog.groups.workspace;

describe('lazy languages', () => {
  beforeAll(() => {
    localStorage.setItem('language', 'de');
  });

  it('has the stored language loaded, in every namespace, when init resolves', async () => {
    const i18n = await initI18n();
    expect(i18n.language).toBe('de');
    expect(i18n.t(key, { ns: 'nav' })).toBe(text(de));
    expect(document.documentElement.lang).toBe('de');
    expect(document.documentElement.dir).toBe('ltr');
    expect(i18n.hasResourceBundle('de', 'common')).toBe(true);
    // not loaded until asked for
    expect(i18n.hasResourceBundle('ar', 'nav')).toBe(false);
  });

  it('loads a language before switching to it, and follows its direction', async () => {
    const { i18n } = await import('@/i18n');
    await i18n.changeLanguage('ar');
    expect(i18n.t(key, { ns: 'nav' })).toBe(text(ar));
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('language')).toBe('ar');
    await i18n.changeLanguage('en');
    expect(i18n.t(key, { ns: 'nav' })).toBe(text(en));
    expect(document.documentElement.dir).toBe('ltr');
  });
});
