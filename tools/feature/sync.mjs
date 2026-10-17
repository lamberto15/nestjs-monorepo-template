#!/usr/bin/env node
// Brings what a feature's record declaration (`<item>.record.ts`) can't
// derive at runtime in line with it, after a field or a capability is added
// or removed: the capabilities' texts in every locale (comments, pdf), the
// feature's paths in the OpenAPI test, and a migration guard. It reads the
// declaration's text (one field per line, as `pnpm feature:add` writes it).
//
//   pnpm feature:sync                  # every feature with a record declaration
//   pnpm feature:sync invoices         # one
//   pnpm feature:sync --check          # CI: fail when anything is out of line
//   node --test tools/feature/add.test.mjs
//
// The guard compares the declaration with the table in the latest drizzle
// snapshot (apps/api/drizzle/meta): a new required field without a
// default, an optional field made required, a field removed, or
// `softDelete` or `team` turned off (their columns dropped), would fail or
// lose data on a table with rows (docs/pitfalls.md, expand/contract).
// Turning them on adds nullable columns: a migration, nothing to fix. What
// the flags change in the code the platform derives (platform/records): a
// generated file that still codes them by hand fails the sync.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { texts } from './capabilities.mjs';
import { names, snake } from './names.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** The columns every record table has besides its fields (platform/records/record.ts). */
const BASE_COLUMNS = new Set([
  'id',
  'tenant_id',
  'owner_id',
  'created_at',
  'updated_at',
  'search',
  'custom',
]);

/**
 * The columns a declaration's flag adds (record.ts: softDelete's recycle
 * bin, team's team), and what dropping them loses.
 */
const FLAG_COLUMNS = {
  softDelete: {
    columns: ['deleted_at', 'deleted_by'],
    off: 'records in the recycle bin would come back as live ones, and who deleted them is lost: restore or purge them first, and drop the columns a release after the code stops reading them',
    on: null,
  },
  team: {
    columns: ['team_id'],
    off: 'which team each record belongs to is lost (with what team leads see): stop using it first, drop it a release later',
    on: 'existing records get no team (team_id empty): team leads see only those created from now on',
  },
};

/**
 * Code a generated file would hold only if written for one value of a flag:
 * the platform does it from the declaration now (platform/records:
 * RecordStore, recordPermissions, RecordPolicy, recordResource, the restore
 * route, record-capabilities.ts), so a match is code to bring to the
 * generated shape (docs/adding-a-feature.md, "Changing a feature").
 */
const HAND_WRITTEN = [
  {
    file: (t) => `src/features/${t.plural}/${t.plural}.service.ts`,
    flag: 'softDelete',
    pattern: /\bdeletedAt\b/,
    what: "the recycle bin's columns (RecordStore)",
  },
  {
    file: (t) => `src/features/${t.plural}/${t.plural}.service.ts`,
    flag: 'team',
    pattern: /\bteamsOf\(|\bteamId\b/,
    what: "the owner's team (RecordStore.owner())",
  },
  {
    file: (t) => `src/features/${t.plural}/${t.plural}.controller.ts`,
    flag: 'softDelete',
    pattern: /:id\/restore'|to the recycle bin\)'/,
    what: "the restore route or the delete route's text (record-restore.routes.ts)",
  },
  {
    file: (t) => `src/features/${t.plural}/${t.singular}.policy.ts`,
    flag: 'team',
    pattern: /\binMyTeams\(|'team-lead'/,
    what: 'the inMyTeams condition or the team lead grant (recordPermissions)',
  },
  {
    file: (t) => `src/features/${t.plural}/${t.singular}.policy.ts`,
    flag: 'softDelete',
    pattern: /action: 'restore'|\brestore: \{|\brestore\(user/,
    what: 'the restore action (recordPermissions, RecordPolicy)',
  },
  {
    file: (t) => `src/features/${t.plural}/${t.singular}.resource.ts`,
    flag: 'softDelete',
    pattern: /\bsoftDelete:/,
    what: 'the recycle bin (recordResource)',
  },
  {
    file: (t) => `src/features/${t.plural}/${t.plural}.controller.ts`,
    flag: 'idempotency',
    pattern: /@Idempotent\(|idempotencyKeyHeader\(/,
    what: "the create route's Idempotency-Key (RecordIdempotent)",
  },
  {
    file: (t) => `test/${t.plural}.e2e-spec.ts`,
    flag: 'softDelete',
    pattern: /\/restore`/,
    what: 'the recycle bin test (record-capabilities.ts)',
  },
];

/** The generated files that still code a flag by hand: one error each. */
export function handWritten(api, record) {
  const errors = [];
  for (const { file, flag, pattern, what } of HAND_WRITTEN) {
    const name = file(record.t);
    const full = path.join(api, name);
    if (!existsSync(full) || !pattern.test(readFileSync(full, 'utf8')))
      continue;
    errors.push(
      `${name} codes ${what} by hand: the platform derives it from ${record.t.singular}.record.ts (${flag}: ${record[flag]}), so flipping ${flag} would leave it stale. Bring the file to the shape \`pnpm feature:add\` writes now (docs/adding-a-feature.md, "Changing a feature").`,
    );
  }
  return errors;
}

/** `InvoiceLine` → `invoice-line`. */
const kebab = (pascal) =>
  pascal.replace(
    /[A-Z]/g,
    (letter, i) => `${i ? '-' : ''}${letter.toLowerCase()}`,
  );

/** The declaration, from its text: names, flags, fields (one per line) and capabilities. */
export function readRecord(file) {
  return readRecordText(readFileSync(file, 'utf8'), file);
}

function readRecordText(text, file) {
  const string = (key) => new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(text)?.[1];
  const flag = (key) =>
    new RegExp(`\\b${key}:\\s*(true|false)`).exec(text)?.[1] === 'true';
  const block = /\bfields:\s*\{([\s\S]*?)\n\s*\},/.exec(text)?.[1];
  const caps = /\bcapabilities:\s*\[([\s\S]*?)\]/.exec(text)?.[1];
  const subject = string('subject');
  const plural = string('path');
  const table = string('table');
  if (
    !subject ||
    !plural ||
    !table ||
    block === undefined ||
    caps === undefined
  ) {
    throw new Error(
      `${file}: not a record declaration sync can read (subject, path, table, fields, capabilities).`,
    );
  }
  const fields = [];
  for (const line of block.split('\n')) {
    const match = /^\s*(\w+):\s*field\.(\w+)\(([^)]*)\)(.*?),?\s*$/.exec(line);
    if (!match) {
      if (line.trim() && !line.trim().startsWith('//')) {
        throw new Error(
          `${file}: keep one field per line, \`name: field.type()…,\` (read: "${line.trim()}").`,
        );
      }
      continue;
    }
    const [, name, kind, arg, modifiers] = match;
    fields.push({
      name,
      type: kind,
      optional: modifiers.includes('.optional()'),
      hasDefault: modifiers.includes('.default(') || kind === 'bool',
      unique: modifiers.includes('.unique()'),
      searchable: modifiers.includes('.searchable()'),
      values:
        kind === 'enum'
          ? [...arg.matchAll(/'([^']+)'/g)].map((m) => m[1])
          : undefined,
    });
  }
  const choice = (key, allowed) => {
    const value = new RegExp(`\\b${key}:\\s*('[^']*'|true|false)`)
      .exec(text)?.[1]
      ?.replace(/'/g, '');
    if (value !== undefined && !allowed.includes(value)) {
      throw new Error(
        `${file}: ${key}: ${value} is not a choice; any of ${allowed.join(', ')}.`,
      );
    }
    return value;
  };
  const clientAccess = choice('clientAccess', ['false', 'own']);
  return {
    subject,
    plural,
    table,
    idempotency: choice('idempotency', ['required', 'optional', 'off']),
    clientAccess: clientAccess === 'own' ? 'own' : false,
    grants: choice('grants', ['standard', 'none']) ?? 'standard',
    softDelete: flag('softDelete'),
    team: flag('team'),
    fields,
    capabilities: new Set([...caps.matchAll(/'([^']+)'/g)].map((m) => m[1])),
    t: names(plural, kebab(subject)),
  };
}

/**
 * A change to who may use the feature (clientAccess, grants) against the
 * committed declaration: the code takes effect on deploy for API clients
 * (clientPermissions are read from the code), but the seed roles are written
 * when a tenant is made, so existing tenants keep their stored roles.
 */
export function permissionWarnings(file, record) {
  let committed;
  try {
    const full = path.resolve(file);
    committed = execFileSync('git', ['show', `HEAD:./${path.basename(full)}`], {
      cwd: path.dirname(full),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return []; // new, or not in git: nothing to compare
  }
  const before = readRecordText(committed, file);
  const warnings = [];
  if (before.clientAccess !== record.clientAccess) {
    warnings.push(
      `clientAccess ${before.clientAccess} -> ${record.clientAccess}: API clients ${record.clientAccess === 'own' ? 'get their own records' : 'lose their own-records access'} on the next deploy, in every tenant; keys already granted a role keep the role's permissions.`,
    );
  }
  if (before.grants !== record.grants) {
    warnings.push(
      `grants ${before.grants} -> ${record.grants}: the seed roles are written when a tenant is made, so existing tenants keep the roles they have (their administrators change them at /v1/access/roles); only new tenants start with the new grants.`,
    );
  }
  return warnings;
}

/** The paths the feature's routes have (the OpenAPI test lists them). */
export function recordPaths(record) {
  const base = `/v1/${record.plural}`;
  const has = (name) => record.capabilities.has(name);
  return [
    base,
    `${base}/{id}`,
    ...(record.softDelete ? [`${base}/{id}/restore`] : []),
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
}

/** The OpenAPI test's sorted path list, with the feature's paths as its declaration has them. */
function syncPaths(api, record, check) {
  const file = path.join(api, 'test/openapi.e2e-spec.ts');
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(
    'expect(Object.keys(document.paths).sort()).toEqual([',
  );
  const end = text.indexOf(']);', start);
  if (start < 0 || end < 0) {
    throw new Error(
      'test/openapi.e2e-spec.ts: its sorted path list moved; sync its paths by hand.',
    );
  }
  const block = text.slice(start, end);
  const open = block.indexOf('[') + 1;
  const paths = [...block.slice(open).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const base = `/v1/${record.plural}`;
  const mine = (p) => p === base || p.startsWith(`${base}/`);
  const wanted = recordPaths(record);
  const all = [
    ...new Set([...paths.filter((p) => !mine(p)), ...wanted]),
  ].sort();
  const added = wanted.filter((p) => !paths.includes(p));
  const removed = paths.filter((p) => mine(p) && !wanted.includes(p));
  if ((added.length || removed.length) && !check) {
    const list = all.map((p) => `      '${p}',`).join('\n');
    writeFileSync(
      file,
      `${text.slice(0, start)}${block.slice(0, open)}\n${list}\n    ${text.slice(end)}`,
    );
  }
  return [
    ...added.map((p) => `OpenAPI test: + ${p}`),
    ...removed.map((p) => `OpenAPI test: - ${p}`),
  ];
}

/**
 * A text with plural forms (`{ one, other }`) gets every form the locale
 * uses (Arabic: zero, one, two, few, many, other), each the `other` text
 * but `one`'s: the catalogs' test asks for them all.
 */
export function withPlurals(value, locale) {
  if (typeof value !== 'object' || value === null) return value;
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

/** `target` with what `wanted` adds, existing values kept: the keys added, as paths. */
function mergeMissing(target, wanted, prefix = '') {
  const added = [];
  for (const [key, value] of Object.entries(wanted)) {
    const here = prefix ? `${prefix}.${key}` : key;
    if (!(key in target)) {
      target[key] = value;
      added.push(here);
    } else if (
      typeof value === 'object' &&
      value !== null &&
      typeof target[key] === 'object'
    ) {
      added.push(...mergeMissing(target[key], value, here));
    }
  }
  return added;
}

/** The capabilities' texts in every locale's namespace file, missing ones added in English. */
function syncTexts(api, record, check) {
  const has = (name) => record.capabilities.has(name);
  const wanted = texts({ t: record.t, fields: record.fields, has });
  const root = path.join(api, 'src/i18n');
  const locales = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const changes = [];
  const translate = [];
  for (const [namespace, entries] of Object.entries(wanted)) {
    for (const locale of locales) {
      const file = path.join(root, locale, `${namespace}.json`);
      const current = JSON.parse(readFileSync(file, 'utf8'));
      const added = mergeMissing(current, withPlurals(entries, locale));
      if (!added.length) continue;
      if (!check) writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
      changes.push(
        ...added.map((key) => `${locale}/${namespace}.json: + ${key}`),
      );
      if (locale !== 'en')
        translate.push(
          ...added.map((key) => `${locale}/${namespace}.json: ${key}`),
        );
    }
  }
  return { changes, translate };
}

/** The table as the latest drizzle snapshot has it: column name → its NOT NULL and default. */
function snapshotTable(api, table) {
  const meta = path.join(api, 'drizzle/meta');
  if (!existsSync(path.join(meta, '_journal.json'))) return null; // nothing migrated yet
  const journal = JSON.parse(
    readFileSync(path.join(meta, '_journal.json'), 'utf8'),
  );
  const last = journal.entries[journal.entries.length - 1];
  if (!last) return null;
  const snapshot = JSON.parse(
    readFileSync(
      path.join(meta, `${String(last.idx).padStart(4, '0')}_snapshot.json`),
      'utf8',
    ),
  );
  const found = snapshot.tables?.[`public.${table}`];
  return found ? found.columns : null;
}

/** The columns a field has (money: its pair). */
const columnsOf = (f) =>
  f.type === 'money'
    ? [`${snake(f.name)}_minor`, `${snake(f.name)}_currency`]
    : [snake(f.name)];

/**
 * What a migration of the declaration would do to a table with rows:
 * errors to fix before `pnpm db:generate`, and whether it has anything to
 * generate.
 */
function guard(api, record) {
  const columns = snapshotTable(api, record.table);
  if (!columns) return { errors: [], warnings: [], generate: true }; // a new table
  const errors = [];
  const warnings = [];
  let generate = false;
  for (const [flag, { columns: added, off, on }] of Object.entries(
    FLAG_COLUMNS,
  )) {
    const present = added.filter((column) => columns[column]);
    if (record[flag] && present.length < added.length) {
      generate = true;
      if (on) warnings.push(`${flag} turned on: ${on}.`);
    } else if (!record[flag] && present.length) {
      generate = true;
      errors.push(
        `${flag} turned off drops ${present.join(' and ')}; ${off} (docs/pitfalls.md, expand/contract).`,
      );
    }
  }
  const declared = new Set();
  for (const f of record.fields) {
    for (const column of columnsOf(f)) {
      declared.add(column);
      const was = columns[column];
      if (!was) {
        generate = true;
        if (!f.optional && !f.hasDefault) {
          errors.push(
            `${record.plural}.${f.name}: a new required field needs .default(…) (or .optional()): the table may have rows.`,
          );
        }
      } else if (!was.notNull && !f.optional) {
        errors.push(
          `${record.plural}.${f.name}: optional before, required now: fill its empty rows first (docs/pitfalls.md, expand/contract), or keep it optional.`,
        );
      } else if (was.notNull === f.optional) {
        generate = true;
      }
    }
  }
  for (const column of Object.keys(columns)) {
    const flagged = Object.values(FLAG_COLUMNS).some((flag) =>
      flag.columns.includes(column),
    );
    if (!BASE_COLUMNS.has(column) && !flagged && !declared.has(column)) {
      errors.push(
        `${record.plural}: the column ${column} has no field any more; dropping it loses data: stop using it first, drop it a release later (docs/pitfalls.md, expand/contract).`,
      );
    }
  }
  if (record.capabilities.has('search') !== Boolean(columns.search))
    generate = true;
  if (record.capabilities.has('custom') !== Boolean(columns.custom)) {
    generate = true;
    if (columns.custom) {
      errors.push(
        `${record.plural}: custom was removed, but the column custom holds the values: dropping it loses data; keep the capability, or stop using the values first (docs/pitfalls.md, expand/contract).`,
      );
    }
  }
  return { errors, warnings, generate };
}

/** One feature: its texts and OpenAPI paths in line (unless `check`), its migration guarded. */
export function syncFeature(api, plural, { check = false } = {}) {
  const dir = path.join(api, 'src/features', plural);
  const file = readdirSync(dir).find((name) => name.endsWith('.record.ts'));
  if (!file) return null; // a hand-written feature (notes): nothing to sync
  const record = readRecord(path.join(dir, file));
  const texts = syncTexts(api, record, check);
  const paths = syncPaths(api, record, check);
  const { errors, warnings, generate } = guard(api, record);
  warnings.push(...permissionWarnings(path.join(dir, file), record));
  return {
    plural,
    changes: [...texts.changes, ...paths],
    translate: texts.translate,
    errors: [...errors, ...handWritten(api, record)],
    warnings,
    generate,
    client: paths.length > 0,
  };
}

/** Every feature with a record declaration. */
export function featureNames(api) {
  const root = path.join(api, 'src/features');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      readdirSync(path.join(root, name)).some((f) => f.endsWith('.record.ts')),
    )
    .sort();
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      root: { type: 'string' },
    },
  });
  const api = path.join(path.resolve(values.root ?? REPO), 'apps/api');
  const features = positionals.length ? positionals : featureNames(api);
  let failed = false;
  for (const plural of features) {
    if (!existsSync(path.join(api, 'src/features', plural))) {
      console.error(`features/${plural} doesn't exist.`);
      failed = true;
      continue;
    }
    const result = syncFeature(api, plural, { check: values.check });
    if (!result) continue;
    for (const change of result.changes)
      console.log(
        `${plural}: ${values.check ? 'out of line' : 'synced'}: ${change}`,
      );
    for (const error of result.errors) console.error(`${plural}: ${error}`);
    for (const warning of result.warnings)
      console.warn(`${plural}: ${warning}`);
    if (result.translate.length) {
      console.log(`${plural}: to translate (English for now):`);
      for (const key of result.translate) console.log(`  ${key}`);
    }
    if (result.generate)
      console.log(`${plural}: run pnpm db:generate (the table changes)`);
    if (result.client)
      console.log(`${plural}: run pnpm client:generate (the routes change)`);
    if (result.errors.length || (values.check && result.changes.length))
      failed = true;
  }
  process.exit(failed ? 1 : 0);
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
