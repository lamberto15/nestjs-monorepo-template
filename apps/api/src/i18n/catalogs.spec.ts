import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Catalog = { [key: string]: string | Catalog };

const DIR = import.meta.dirname;
const locales = readdirSync(DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const namespaces = readdirSync(join(DIR, 'en')).filter((file) =>
  file.endsWith('.json'),
);
const PLURAL = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

const isPlural = (value: Catalog) =>
  Object.keys(value).every((key) => PLURAL.has(key));

/** Every message key (a plural message is one key), with its placeholders. */
function messages(catalog: Catalog, prefix = ''): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      found.set(path, placeholders(value));
    } else if (isPlural(value)) {
      found.set(
        path,
        placeholders((Object.values(value) as string[]).join(' ')).filter(
          (p) => p !== 'count',
        ),
      );
    } else {
      for (const [inner, names] of messages(value, path)) {
        found.set(inner, names);
      }
    }
  }
  return found;
}

const placeholders = (text: string) =>
  [
    ...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])),
  ].sort();

/** The plural messages and the forms each has. */
function plurals(catalog: Catalog, prefix = ''): [string, string[]][] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') return [];
    return isPlural(value)
      ? [[path, Object.keys(value)]]
      : plurals(value, path);
  });
}

const load = (locale: string, namespace: string) =>
  JSON.parse(readFileSync(join(DIR, locale, namespace), 'utf8')) as Catalog;

describe.each(locales.filter((locale) => locale !== 'en'))(
  'the %s catalogs',
  (locale) => {
    it.each(namespaces)(
      '%s has the English keys and placeholders',
      (namespace) => {
        const english = messages(load('en', namespace));
        const translated = messages(load(locale, namespace));
        expect([...translated.keys()].sort()).toEqual(
          [...english.keys()].sort(),
        );
        for (const [key, names] of english) {
          expect({ key, names: translated.get(key) }).toEqual({ key, names });
        }
      },
    );

    it.each(namespaces)(
      '%s has every plural form the language needs',
      (namespace) => {
        const needed = new Intl.PluralRules(locale).resolvedOptions()
          .pluralCategories;
        for (const [key, forms] of plurals(load(locale, namespace))) {
          expect({
            key,
            missing: needed.filter((form) => !forms.includes(form)),
          }).toEqual({ key, missing: [] });
        }
      },
    );
  },
);
