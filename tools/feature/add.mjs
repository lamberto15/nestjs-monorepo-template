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
//   pnpm feature:add payments --fields "…" --idempotency required --client-access own --grants none
//   pnpm feature:add people --singular person --fields "name:string"
//   pnpm feature:add invoices --fields "…" --with tags,comments,attachments,revisions,pdf,bulk,watch,search,transfer,custom
//   pnpm feature:add invoices --fields "…" --approvals publish,markPaid --settings "paymentDays:int=30,autoSend:flag"
//   node --test tools/feature/add.test.mjs                  # its tests
//
// Field types: string, text, int, decimal, money, bool, date, datetime,
// enum(a|b), json, ref(<feature>)?; `?` optional, `!unique` unique per tenant.
// Then: pnpm db:generate (new tables: drizzle-kit asks nothing),
// pnpm client:generate, and the check before every commit (CLAUDE.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CAPABILITIES,
  parseApprovals,
  parseCapabilities,
  parseChoices,
  parseSettings,
} from './capabilities.mjs';
import { format } from './format.mjs';
import { parseFields } from './fields.mjs';
import { names } from './names.mjs';
import { checkout, inside } from './paths.mjs';
import * as templates from './templates.mjs';
import { syncFeature } from './sync.mjs';

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
 * when the input is wrong: a `root` that isn't a checkout, a name or a path
 * that would leave it.
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
  const approvals = parseApprovals(options.approvals);
  const settings = parseSettings(options.settings, approvals);
  const repo = checkout(root, 'apps/api/src/features/index.ts');
  const api = inside(repo, 'apps/api');
  const dir = inside(api, 'src/features', t.plural);
  if (existsSync(dir)) {
    throw new Error(`features/${t.plural} exists already.`);
  }
  for (const ref of new Set(fields.filter((f) => f.ref).map((f) => f.ref))) {
    const file = inside(api, 'src/features', ref, `${ref}.tables.ts`);
    if (!existsSync(file)) {
      throw new Error(
        `ref(${ref}): there is no features/${ref}/${ref}.tables.ts.`,
      );
    }
    // A record's table (recordTable) always is; a hand-written one says so.
    const text = readFileSync(file, 'utf8');
    if (!text.includes('recordTable(') && !text.includes('referenced: true')) {
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
    ...parseChoices(options),
    capabilities,
    approvals,
    settings,
    description:
      options.description || `${t.nouns[0].toUpperCase()}${t.nouns.slice(1)}`,
  };

  const files = {
    [`${t.singular}.record.ts`]: templates.record(context),
    [`${t.plural}.tables.ts`]: templates.tables(context),
    [`${t.singular}.schemas.ts`]: templates.schemas(context),
    [`${t.singular}.list.ts`]: templates.list(context),
    [`${t.singular}.resource.ts`]: templates.resource(context),
    [`${t.singular}.policy.ts`]: templates.policy(context),
    [`${t.plural}.service.ts`]: templates.service(context),
    [`${t.plural}.controller.ts`]: templates.controller(context),
    [`${t.plural}.module.ts`]: templates.moduleFile(context),
    [`${t.plural}.feature.ts`]: templates.feature(context),
    // The business logic of what approval does: one entry per action.
    ...(approvals.length && {
      [`${t.singular}.approvals.ts`]: templates.approvals(context),
    }),
  };
  const written = [];
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = inside(dir, name);
    writeFileSync(file, await format(file, text));
    written.push(path.relative(repo, file));
  }
  const spec = inside(api, 'test', `${t.plural}.e2e-spec.ts`);
  writeFileSync(spec, await format(spec, templates.e2e(context)));
  written.push(path.relative(repo, spec));

  const changed = [await appendFeature(api, t), await appendTables(api, t)].map(
    (file) => path.relative(repo, file),
  );
  // Its texts and OpenAPI paths, as `pnpm feature:sync` keeps them.
  const synced = await syncFeature(api, t.plural);
  return {
    written,
    changed: [...changed, ...synced.changes],
    names: t,
    translate: synced.translate,
  };
}

/** features/index.ts: the import and the list entry, at the markers. */
async function appendFeature(api, t) {
  const file = inside(api, 'src/features/index.ts');
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
  const file = inside(api, 'src/features/tables.ts');
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

const USAGE = `pnpm feature:add <plural-name> --fields "name:type,…" [--with ${CAPABILITIES.join(',')}] [--singular <name>] [--team] [--no-soft-delete] [--idempotency required|optional|off] [--client-access own] [--grants none] [--approvals publish,…] [--settings "name:int=30,…"] [--description "…"]`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      fields: { type: 'string' },
      singular: { type: 'string' },
      team: { type: 'boolean', default: false },
      'soft-delete': { type: 'boolean', default: true },
      idempotency: { type: 'string' },
      'client-access': { type: 'string' },
      grants: { type: 'string' },
      description: { type: 'string' },
      with: { type: 'string' },
      approvals: { type: 'string' },
      settings: { type: 'string' },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  // --root: a checkout of the template (addFeature checks it), this one by default.
  const result = await addFeature(values.root ?? REPO, {
    name: positionals[0],
    fields: values.fields,
    singular: values.singular,
    team: values.team,
    softDelete: values['soft-delete'],
    idempotency: values.idempotency,
    clientAccess: values['client-access'],
    grants: values.grants,
    description: values.description,
    with: values.with,
    approvals: values.approvals,
    settings: values.settings,
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
