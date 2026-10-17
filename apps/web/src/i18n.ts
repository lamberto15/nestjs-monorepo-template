import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from '@/locales/ar/common.json';
import de from '@/locales/de/common.json';
import en from '@/locales/en/common.json';
import ms from '@/locales/ms/common.json';
import zh from '@/locales/zh/common.json';

// The API's locales (LOCALES in env.example).
export const languages = ['en', 'de', 'ar', 'zh', 'ms'] as const;
export type Language = (typeof languages)[number];

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
    resources: {
      en: { common: en },
      de: { common: de },
      ar: { common: ar },
      zh: { common: zh },
      ms: { common: ms },
    },
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
