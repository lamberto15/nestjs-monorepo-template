import i18n from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

// The API's locales (LOCALES in env.example).
export const languages = ['en', 'de', 'ar', 'zh', 'ms'] as const;
export type Language = (typeof languages)[number];

// Every src/locales/<lng>/<ns>.json is the namespace <ns>.
//
// `en` is bundled: it is the fallback language, so a key missing elsewhere
// (or a language not loaded yet) still shows English, never a bare key.
const bundled = import.meta.glob<Record<string, unknown>>(
  '@/locales/en/*.json',
  {
    eager: true,
    import: 'default',
  },
);

// Every other language is loaded on demand, one chunk per language
// (`codeSplitting` in vite.config.ts), through i18next-resources-to-backend,
// i18next's documented way to load resources lazily with a bundler's dynamic
// import (i18next "Add or load translations", "Lazy load in-memory
// translations"). A non-eager glob alone would leave the loading, the
// namespaces and the fallback to custom code; the backend plugs into
// i18next's own `changeLanguage`, which loads before it switches.
const lazy = import.meta.glob<Record<string, unknown>>(
  ['@/locales/*/*.json', '!@/locales/en/*.json'],
  { import: 'default' },
);

const loaders = new Map(
  Object.entries(lazy).flatMap(([path, load]) => {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    return match ? [[`${match[1]}/${match[2]}`, load] as const] : [];
  }),
);

/** The namespaces: the file names of `en`, which is complete. */
const namespaces = Object.keys(resourcesFrom(bundled).en ?? {});

/** `{ en: { common: {...}, nav: {...} }, de: ... }` from the glob. */
export function resourcesFrom(
  modules: Record<string, Record<string, unknown>>,
) {
  const resources: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [path, texts] of Object.entries(modules)) {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (match?.[1] && match[2]) {
      (resources[match[1]] ??= {})[match[2]] = texts;
    }
  }
  return resources;
}

const storageKey = 'language';

function stored(): Language | undefined {
  try {
    const value = localStorage.getItem(storageKey);
    return languages.find((language) => language === value);
  } catch {
    return undefined;
  }
}

function fromBrowser(): Language {
  for (const tag of navigator.languages) {
    const found = languages.find((language) => tag.split('-')[0] === language);
    if (found) {
      return found;
    }
  }
  return 'en';
}

/** <html lang> and dir (Arabic is right-to-left) follow the language. */
function applyToDocument(language: string) {
  document.documentElement.lang = language;
  document.documentElement.dir = i18n.dir(language);
}

export async function initI18n() {
  await i18n
    .use(initReactI18next)
    .use(
      resourcesToBackend((language: string, namespace: string) =>
        loaders.get(`${language}/${namespace}`)?.(),
      ),
    )
    .init({
      // `en` is in memory; `partialBundledLanguages` lets the backend load the
      // others. Every namespace of the active language is loaded before the
      // first paint (a page's `useTranslation` then never suspends or flashes keys).
      resources: resourcesFrom(bundled),
      partialBundledLanguages: true,
      ns: namespaces,
      lng: stored() ?? fromBrowser(),
      fallbackLng: 'en',
      supportedLngs: languages,
      defaultNS: 'common',
      interpolation: { escapeValue: false },
    });
  applyToDocument(i18n.language);
  i18n.on('languageChanged', (language) => {
    applyToDocument(language);
    try {
      localStorage.setItem(storageKey, language);
    } catch {
      // storage blocked: the choice lasts until reload
    }
  });
  return i18n;
}

export { i18n };
