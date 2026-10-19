/**
 * The languages the app ships catalogs for (`src/i18n/<locale>`): LOCALES'
 * default. A deployment's LOCALES may enable fewer.
 */
export const SHIPPED_LOCALES = ['en', 'de', 'ar', 'zh', 'ms'] as const;

/** Regional locales and the language whose catalogs they read (their own date and number formats). */
export const REGIONS: Record<string, string> = {
  'ar-AE': 'ar',
  'en-SG': 'en',
  'zh-SG': 'zh',
  'ms-SG': 'ms',
};
