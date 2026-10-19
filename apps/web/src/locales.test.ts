import { describe, expect, it } from 'vitest';

// Every locale file of every language, loaded the way the app loads them.
const files = import.meta.glob<Record<string, unknown>>('@/locales/*/*.json', {
  eager: true,
  import: 'default',
});

const others = ['de', 'ar', 'zh', 'ms'];
const pluralSuffix = /_(zero|one|two|few|many|other)$/;

function flatten(
  value: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
) {
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'object' && v !== null) {
      flatten(v as Record<string, unknown>, `${prefix}${key}.`, out);
    } else {
      out[`${prefix}${key}`] = String(v);
    }
  }
  return out;
}

const byLanguage: Record<string, Record<string, Record<string, string>>> = {};
for (const [path, json] of Object.entries(files)) {
  const [, lng, name] = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
  if (!lng || !name) continue;
  (byLanguage[lng] ??= {})[name] = flatten(json);
}

const placeholders = (text: string) =>
  new Set(
    text.match(/\{\{\s*[\w.]+\s*\}\}/g)?.map((p) => p.replace(/\s/g, '')),
  );

describe('locale files', () => {
  const en = byLanguage['en'] ?? {};

  it.each(others)('%s has a file for every en namespace', (lng) => {
    expect(Object.keys(byLanguage[lng] ?? {}).toSorted()).toEqual(
      Object.keys(en).toSorted(),
    );
  });

  describe.each(others)('%s', (lng) => {
    it.each(Object.keys(en))('%s misses no key of en', (name) => {
      const translated = byLanguage[lng]?.[name] ?? {};
      // Languages have their own plural forms (zh has only "other", ar has six):
      // a plural key counts as present when any of its forms is.
      const base = (key: string) => key.replace(pluralSuffix, '');
      const present = new Set(Object.keys(translated).map(base));
      const missing = Object.keys(en[name] ?? {}).filter(
        (key) => !present.has(base(key)),
      );
      expect(missing).toEqual([]);
    });

    it.each(Object.keys(en))('%s keeps every {{placeholder}} of en', (name) => {
      const translated = byLanguage[lng]?.[name] ?? {};
      const lost: string[] = [];
      for (const [key, text] of Object.entries(en[name] ?? {})) {
        const mine = translated[key];
        if (mine === undefined) continue;
        // A plural form may spell a number out ("one permission") instead of
        // using {{count}}.
        const plural = pluralSuffix.test(key);
        for (const p of placeholders(text)) {
          if (plural && p === '{{count}}') continue;
          if (!placeholders(mine).has(p)) lost.push(`${key}: ${p}`);
        }
      }
      expect(lost).toEqual([]);
    });
  });
});
