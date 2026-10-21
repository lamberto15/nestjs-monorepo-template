// `pnpm i18n:check`: the translation catalogs of the web app and the API stay
// in step with English (docs/i18n-and-time.md, "Parity check"). For every
// locale and namespace:
//   - the same message keys as `en`: none missing, none stale;
//   - a plural message has exactly the forms the language uses
//     (Intl.PluralRules: Arabic six, English two, Chinese and Malay one),
//     so `_one` is not "missing" from zh and `_zero` is not "stale" in ar;
//   - the same interpolation placeholders ({{name}} in the web app, {name} in
//     the API); `count` of a plural message is exempt (a form may spell the
//     number out).
// Custom code: no i18n library ships a parity check across files.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const SUFFIX = /_(zero|one|two|few|many|other)$/;

export const TREES = [
  {
    name: 'web',
    dir: join(ROOT, 'apps/web/src/locales'),
    // i18next: flat keys with a `_<form>` suffix, `{{name}}` placeholders.
    plural: 'suffix',
    placeholder: /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g,
  },
  {
    name: 'api',
    dir: join(ROOT, 'apps/api/src/i18n'),
    // nestjs-i18n: a plural message is an object of forms, `{name}` placeholders.
    plural: 'object',
    placeholder: /\{(\w+)\}/g,
  },
];

const isPluralObject = (value) =>
  Object.keys(value).length > 0 &&
  Object.keys(value).every((k) => FORMS.includes(k));

const placeholdersOf = (texts, tree) =>
  new Set(
    texts.flatMap((text) =>
      [...text.matchAll(tree.placeholder)].map((m) => m[1]),
    ),
  );

/** Message path -> { forms: string[] | null, texts: string[] }. */
export function messagesOf(catalog, tree) {
  const found = new Map();
  const add = (path, form, text) => {
    const entry = found.get(path) ?? { forms: form ? [] : null, texts: [] };
    if (form) entry.forms.push(form);
    entry.texts.push(text);
    found.set(path, entry);
  };
  const walk = (value, prefix) => {
    for (const [key, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof v === 'string') {
        const form =
          tree.plural === 'suffix' ? SUFFIX.exec(key)?.[1] : undefined;
        if (form) add(path.replace(SUFFIX, ''), form, v);
        else add(path, undefined, v);
      } else if (tree.plural === 'object' && isPluralObject(v)) {
        for (const [form, text] of Object.entries(v))
          add(path, form, String(text));
      } else {
        walk(v, path);
      }
    }
  };
  walk(catalog, '');
  return found;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Problems of one locale's namespace against English (a list of strings). */
export function compare(locale, english, translated, tree) {
  const problems = [];
  for (const key of english.keys()) {
    if (!translated.has(key)) problems.push(`missing key ${key}`);
  }
  for (const key of translated.keys()) {
    if (!english.has(key)) problems.push(`stale key ${key} (not in en)`);
  }
  const needed = new Intl.PluralRules(locale).resolvedOptions()
    .pluralCategories;
  for (const [key, entry] of translated) {
    const en = english.get(key);
    if (!en) continue;
    if (Boolean(entry.forms) !== Boolean(en.forms)) {
      problems.push(
        `${key}: ${en.forms ? 'must be' : 'must not be'} a plural message`,
      );
      continue;
    }
    if (entry.forms) {
      for (const form of needed) {
        if (!entry.forms.includes(form))
          problems.push(`${key}: missing plural form ${form}`);
      }
      for (const form of entry.forms) {
        if (!needed.includes(form)) {
          problems.push(
            `${key}: plural form ${form} is unused by ${locale} (stale)`,
          );
        }
      }
    }
    const want = placeholdersOf(en.texts, tree);
    const have = placeholdersOf(entry.texts, tree);
    if (entry.forms) {
      want.delete('count');
      have.delete('count');
    }
    if (!sameSet(want, have)) {
      problems.push(
        `${key}: placeholders {${[...have].sort()}} differ from en {${[...want].sort()}}`,
      );
    }
  }
  return problems;
}

const subdirs = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
const jsonFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .toSorted();
const load = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Every problem of a tree as `tree/locale/namespace.json: problem`. */
export function checkTree(tree) {
  const report = [];
  const locales = subdirs(tree.dir).toSorted();
  const namespaces = jsonFiles(join(tree.dir, 'en'));
  for (const locale of locales) {
    const files = jsonFiles(join(tree.dir, locale));
    for (const file of namespaces.filter((f) => !files.includes(f))) {
      report.push(`${tree.name}/${locale}/${file}: file missing`);
    }
    for (const file of files.filter((f) => !namespaces.includes(f))) {
      report.push(`${tree.name}/${locale}/${file}: stale file (not in en)`);
    }
    for (const file of namespaces.filter((f) => files.includes(f))) {
      const english = messagesOf(load(join(tree.dir, 'en', file)), tree);
      // English is checked against itself for its own plural forms.
      const translated =
        locale === 'en'
          ? english
          : messagesOf(load(join(tree.dir, locale, file)), tree);
      for (const problem of compare(locale, english, translated, tree)) {
        report.push(`${tree.name}/${locale}/${file}: ${problem}`);
      }
    }
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = TREES.flatMap(checkTree);
  if (report.length > 0) {
    console.error(report.join('\n'));
    console.error(`\ni18n:check found ${report.length} problem(s).`);
    process.exit(1);
  }
  console.log('i18n:check ok: web and API catalogs match English.');
}
