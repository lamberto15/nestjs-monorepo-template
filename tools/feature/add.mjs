#!/usr/bin/env node
// A new feature with its standard parts (docs/adding-a-feature.md), so its
// author writes only the business logic: the table (tenant, owner,
// timestamps, recycle bin), schemas, list filters, permissions and policy,
// audited service, controller (idempotent create, ETags, field checks),
// record-route spec, module and declaration (`<x>.feature.ts`), and an e2e
// test of the standard routes. It appends to features/index.ts,
// features/tables.ts and the OpenAPI test's path list, and edits nothing
// else: the groups read those lists.
//
//   pnpm feature:add invoices --fields "title:string,amount:money,dueOn:date?,status:enum(draft|sent|paid)"
//   pnpm feature:add invoices --fields "…" --team --no-soft-delete --description "Invoices to customers"
//   pnpm feature:add people --singular person --fields "name:string"
//   pnpm feature:add invoices --fields "…" --with tags,comments,attachments,revisions,pdf,bulk,watch,search,transfer
//   node --test tools/feature/add.test.mjs                  # its tests
//
// Field types: string, text, int, decimal, money, bool, date, datetime,
// enum(a|b), json, ref(<feature>)?; `?` optional, `!unique` unique per tenant.
// Then: pnpm db:generate (new tables: drizzle-kit asks nothing),
// pnpm client:generate, and the check before every commit (CLAUDE.md).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CAPABILITIES,
  documentTemplate,
  parseCapabilities,
  parts,
} from './capabilities.mjs';
import { parseFields } from './fields.mjs';
import { names } from './names.mjs';
import * as templates from './templates.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Names a feature can't take: they'd collide with the groups' routes or files. */
const RESERVED = new Set([
  'access',
  'account',
  'api',
  'auth',
  'bulk',
  'data',
  'documents',
  'features',
  'files',
  'health',
  'metrics',
  'ops',
  'settings',
  'subscriptions',
  'tags',
  'tenants',
  'webhooks',
]);

/** The markers the barrels keep, so an append lands in the same place every time. */
export const MARKERS = {
  imports: '// pnpm feature:add: imports above this line.',
  features: '// pnpm feature:add: features above this line.',
};

/**
 * Writes the feature under `root` (the repository). Returns the paths
 * written and changed, relative to `root`; throws before writing anything
 * when the input is wrong.
 */
export async function addFeature(root, options) {
  const t = names(options.name, options.singular);
  if (RESERVED.has(t.plural)) {
    throw new Error(
      `"${t.plural}" is taken by the template's own routes; choose another name.`,
    );
  }
  const fields = parseFields(options.fields);
  const capabilities = parseCapabilities(options.with, fields);
  const api = path.join(root, 'apps/api');
  const dir = path.join(api, 'src/features', t.plural);
  if (existsSync(dir)) {
    throw new Error(`features/${t.plural} exists already.`);
  }
  for (const ref of new Set(fields.filter((f) => f.ref).map((f) => f.ref))) {
    const file = path.join(api, 'src/features', ref, `${ref}.tables.ts`);
    if (!existsSync(file)) {
      throw new Error(
        `ref(${ref}): there is no features/${ref}/${ref}.tables.ts.`,
      );
    }
    if (!readFileSync(file, 'utf8').includes('referenced: true')) {
      throw new Error(
        `ref(${ref}): its table must be referenceable first: tenantTable('…', table, { referenced: true }) in ${ref}.tables.ts, then pnpm db:generate.`,
      );
    }
  }
  const context = {
    t,
    fields,
    softDelete: options.softDelete !== false,
    team: options.team === true,
    capabilities,
    description:
      options.description || `${t.nouns[0].toUpperCase()}${t.nouns.slice(1)}`,
  };

  const files = {
    [`${t.plural}.tables.ts`]: templates.tables(context),
    [`${t.singular}.schemas.ts`]: templates.schemas(context),
    [`${t.singular}.list.ts`]: templates.list(context),
    [`${t.singular}.resource.ts`]: templates.resource(context),
    [`${t.singular}.policy.ts`]: templates.policy(context),
    [`${t.plural}.service.ts`]: templates.service(context),
    [`${t.plural}.controller.ts`]: templates.controller(context),
    [`${t.singular}.routes.ts`]: templates.routes(context),
    [`${t.plural}.module.ts`]: templates.moduleFile(context),
    [`${t.plural}.feature.ts`]: templates.feature(context),
  };
  const extra = parts(context);
  Object.assign(files, extra.files);
  const written = [];
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    writeFileSync(file, await format(file, text));
    written.push(path.relative(root, file));
  }
  const spec = path.join(api, 'test', `${t.plural}.e2e-spec.ts`);
  writeFileSync(spec, await format(spec, templates.e2e(context)));
  written.push(path.relative(root, spec));

  if (capabilities.has('pdf')) {
    const page = path.join(
      api,
      'src/documents/templates',
      `${t.singular}.html`,
    );
    writeFileSync(page, documentTemplate());
    written.push(path.relative(root, page));
  }
  const translate = await addTexts(api, extra.texts);

  const changed = [
    await appendFeature(api, t),
    await appendTables(api, t),
    await addOpenApiPaths(api, t, context.softDelete, capabilities),
    ...translate.files,
  ].map((file) => path.relative(root, file));
  return { written, changed, names: t, translate: translate.keys };
}

/** features/index.ts: the import and the list entry, at the markers. */
async function appendFeature(api, t) {
  const file = path.join(api, 'src/features/index.ts');
  const text = readFileSync(file, 'utf8');
  for (const marker of Object.values(MARKERS)) {
    if (!text.includes(marker)) {
      throw new Error(
        `features/index.ts lost its marker "${marker}": put it back where it was.`,
      );
    }
  }
  const updated = text
    .replace(
      MARKERS.imports,
      `import { ${t.PLURAL}_FEATURE } from './${t.plural}/${t.plural}.feature.js';\n${MARKERS.imports}`,
    )
    .replace(MARKERS.features, `${t.PLURAL}_FEATURE,\n  ${MARKERS.features}`);
  writeFileSync(file, await format(file, updated));
  return file;
}

/** features/tables.ts: one export line. */
async function appendTables(api, t) {
  const file = path.join(api, 'src/features/tables.ts');
  const text = readFileSync(file, 'utf8').trimEnd();
  writeFileSync(
    file,
    await format(
      file,
      `${text}\nexport * from './${t.plural}/${t.plural}.tables.js';\n`,
    ),
  );
  return file;
}

/** The OpenAPI test lists every path, sorted as the test sorts them: the feature's join it. */
export async function addOpenApiPaths(
  api,
  t,
  softDelete,
  capabilities = new Set(),
) {
  const file = path.join(api, 'test/openapi.e2e-spec.ts');
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(
    'expect(Object.keys(document.paths).sort()).toEqual([',
  );
  const end = text.indexOf(']);', start);
  if (start < 0 || end < 0) {
    throw new Error(
      'test/openapi.e2e-spec.ts: its sorted path list moved; add the paths by hand.',
    );
  }
  const head = text.slice(0, start);
  const block = text.slice(start, end);
  const open = block.indexOf('[') + 1;
  const paths = [...block.slice(open).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const base = `/v1/${t.plural}`;
  const has = (name) => capabilities.has(name);
  const added = [
    base,
    `${base}/{id}`,
    ...(softDelete ? [`${base}/{id}/restore`] : []),
    ...(has('bulk') ? [`${base}/bulk`] : []),
    ...(has('attachments') ? [`${base}/{id}/attachments`] : []),
    ...(has('comments')
      ? [`${base}/{id}/comments`, `${base}/{id}/comments/{commentId}`]
      : []),
    ...(has('pdf') ? [`${base}/{id}/pdf`] : []),
    ...(has('revisions')
      ? [
          `${base}/{id}/revisions`,
          `${base}/{id}/revisions/{a}/diff/{b}`,
          `${base}/{id}/revisions/{number}`,
          `${base}/{id}/revisions/{number}/restore`,
        ]
      : []),
    ...(has('tags') ? [`${base}/{id}/tags`] : []),
    ...(has('watch') ? [`${base}/{id}/watch`] : []),
  ];
  const all = [...new Set([...paths, ...added])].sort();
  const list = all.map((p) => `      '${p}',`).join('\n');
  const updated = `${head}${block.slice(0, open)}\n${list}\n    ${text.slice(end)}`;
  writeFileSync(file, await format(file, updated));
  return file;
}

/**
 * The capabilities' texts (notifications, PDF labels) in every locale's
 * namespace file: English everywhere, so the app runs in every language;
 * the keys outside en/ are returned to be translated.
 */
async function addTexts(api, texts) {
  const files = [];
  const keys = [];
  const root = path.join(api, 'src/i18n');
  const locales = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const [namespace, entries] of Object.entries(texts)) {
    for (const locale of locales) {
      const file = path.join(root, locale, `${namespace}.json`);
      if (!existsSync(file)) {
        throw new Error(`i18n/${locale}/${namespace}.json is missing.`);
      }
      const current = JSON.parse(readFileSync(file, 'utf8'));
      for (const key of Object.keys(entries)) {
        if (key in current) {
          throw new Error(
            `i18n/${locale}/${namespace}.json has "${key}" already.`,
          );
        }
      }
      writeFileSync(
        file,
        `${JSON.stringify({ ...current, ...withPlurals(entries, locale) }, null, 2)}\n`,
      );
      files.push(file);
      if (locale !== 'en') {
        keys.push(
          ...Object.keys(entries).map(
            (key) => `${locale}/${namespace}.json: ${key}`,
          ),
        );
      }
    }
  }
  return { files, keys };
}

/**
 * A text with plural forms (`{ one, other }`) gets every form the locale
 * uses (Arabic: zero, one, two, few, many, other), each the `other` text
 * but `one`'s: the catalogs' test asks for them all.
 */
function withPlurals(value, locale) {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 2 && 'one' in value && 'other' in value) {
    const forms = new Intl.PluralRules(locale).resolvedOptions()
      .pluralCategories;
    return Object.fromEntries(
      forms.map((form) => [form, form === 'one' ? value.one : value.other]),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      withPlurals(inner, locale),
    ]),
  );
}

/** Formats as `pnpm format` would (the repository's Prettier config). */
async function format(file, text) {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(text, { ...config, filepath: file });
}

const USAGE = `pnpm feature:add <plural-name> --fields "name:type,…" [--with ${CAPABILITIES.join(',')}] [--singular <name>] [--team] [--no-soft-delete] [--description "…"]`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      fields: { type: 'string' },
      singular: { type: 'string' },
      team: { type: 'boolean', default: false },
      'soft-delete': { type: 'boolean', default: true },
      description: { type: 'string' },
      with: { type: 'string' },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const result = await addFeature(path.resolve(values.root ?? REPO), {
    name: positionals[0],
    fields: values.fields,
    singular: values.singular,
    team: values.team,
    softDelete: values['soft-delete'],
    description: values.description,
    with: values.with,
  });
  const t = result.names;
  console.log(`Added features/${t.plural}:`);
  for (const file of result.written) console.log(`  + ${file}`);
  for (const file of result.changed) console.log(`  ~ ${file}`);
  if (result.translate.length) {
    console.log(`\nTo translate (English for now):`);
    for (const key of result.translate) console.log(`  ${key}`);
  }
  console.log(`
Next:
  pnpm db:generate        # the ${t.table} table's migration (review it, commit apps/api/drizzle/)
  pnpm client:generate    # the typed client
  Business logic: ${t.plural}.service.ts, where it says "Business logic".
  Record routes (tags, comments, attachments…): docs/adding-a-feature.md.
  Then the check before every commit (CLAUDE.md).`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
