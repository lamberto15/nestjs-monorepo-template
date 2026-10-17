import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// The API's locales (LOCALES in env.example).
export const languages = ['en', 'de', 'ar', 'zh', 'ms'] as const;
export type Language = (typeof languages)[number];

// Every src/locales/<lng>/<ns>.json is the namespace <ns>. Eager: the app is
// small and a namespace missing at first paint would flash keys. (i18next's
// lazy way is a backend such as i18next-resources-to-backend; switch to it
// when the texts outgrow the bundle.)
const files = import.meta.glob<Record<string, unknown>>('@/locales/*/*.json', {
  eager: true,
  import: 'default',
});

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
  await i18n.use(initReactI18next).init({
    resources: resourcesFrom(files),
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
