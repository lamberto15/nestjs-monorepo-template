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
// Approvals (`approvals` in the declaration) and settings (`settings`) need
// no migration: the platform derives the approvable actions, their routes and
// flags, and the settings. Sync keeps what only the feature can write in line:
// `<item>.approvals.ts` (one entry of business logic per action, added as a
// stub and removed while still the stub) and its two lines in the module, and
// the actions' paths in the OpenAPI test.
//
// The guard compares the declaration with the table in the latest drizzle
// snapshot (apps/api/drizzle/meta): a new required field without a
// default, an optional field made required, a field removed, or
// `softDelete` or `unit` turned off (their columns dropped), would fail or
// lose data on a table with rows (docs/pitfalls.md, expand/contract).
// Turning them on adds nullable columns: a migration, nothing to fix. What
// the flags change in the code the platform derives (platform/records): a
// generated file that still codes them by hand fails the sync.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { texts } from './capabilities.mjs';
import { format } from './format.mjs';
import { names, snake } from './names.mjs';
import { checkout, FEATURE_NAME, inside } from './paths.mjs';
import * as templates from './templates.mjs';

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
  'number',
  'search',
  'custom',
]);

/**
 * The columns a declaration's flag adds (record.ts: softDelete's recycle
 * bin, unit's organizational unit), and what dropping them loses.
 */
const FLAG_COLUMNS = {
  softDelete: {
    columns: ['deleted_at', 'deleted_by'],
    off: 'records in the recycle bin would come back as live ones, and who deleted them is lost: restore or purge them first, and drop the columns a release after the code stops reading them',
    on: null,
  },
  unit: {
    columns: ['unit_id'],
    off: 'which organizational unit each record belongs to is lost (with what unit leads see): stop using it first, drop it a release later',
    on: 'existing records get no unit (unit_id empty): unit leads see only those created from now on',
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
    flag: 'unit',
    pattern: /\bunitsOf\(|\bunitId\b/,
    what: "the owner's organizational unit (RecordStore.owner())",
  },
  {
    file: (t) => `src/features/${t.plural}/${t.plural}.controller.ts`,
    flag: 'softDelete',
    pattern: /:id\/restore'|to the recycle bin\)'/,
    what: "the restore route or the delete route's text (record-restore.routes.ts)",
  },
  {
    file: (t) => `src/features/${t.plural}/${t.singular}.policy.ts`,
    flag: 'unit',
    pattern: /\binMyUnits(AndBelow)?\(|\binUnitsILeadAndBelow\(|'unit-lead'/,
    what: 'the inMyUnits conditions or the unit lead grant (recordPermissions)',
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
    const full = inside(api, name);
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

const isSpace = (char) => /\s/.test(char);

/**
 * What `fields: {` holds, up to the line break before the `},` that closes
 * it (only whitespace between them), or undefined: what
 * `/\bfields:\s*\{([\s\S]*?)\n\s*\},/` captured. A loop for the end, not that
 * regex: it scans to the end again from every `fields: {` and every line
 * break, quadratic or worse on a file that doesn't close one (SonarCloud
 * S8786). The loop skips each run of whitespace once: the line breaks in it
 * all lead to the same `},` or to none.
 */
function fieldsBlock(text) {
  const open = /\bfields:\s*\{/.exec(text);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  for (let from = start; ;) {
    const lineBreak = text.indexOf('\n', from);
    if (lineBreak === -1) return undefined;
    let end = lineBreak + 1;
    while (end < text.length && isSpace(text[end])) end++;
    if (text.startsWith('},', end)) return text.slice(start, lineBreak);
    from = end;
  }
}

/** The declaration, from its text: names, flags, fields (one per line) and capabilities. */
export function readRecord(file) {
  return readRecordText(readFileSync(file, 'utf8'), file);
}

function readRecordText(text, file) {
  const string = (key) => new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(text)?.[1];
  const flag = (key) =>
    new RegExp(`\\b${key}:\\s*(true|false)`).exec(text)?.[1] === 'true';
  const block = fieldsBlock(text);
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
    // The line without its trailing whitespace, then its last comma: one
    // pattern for both (`(.*?),?\s*$`) backtracks in quadratic time over a
    // long line (SonarCloud S8786).
    const match = /^\s*(\w+):\s*field\.(\w+)\(([^)]*)\)(.*)$/.exec(
      line.trimEnd(),
    );
    if (!match) {
      if (line.trim() && !line.trim().startsWith('//')) {
        throw new Error(
          `${file}: keep one field per line, \`name: field.type()…,\` (read: "${line.trim()}").`,
        );
      }
      continue;
    }
    const [, name, kind, arg, rest] = match;
    const modifiers = rest.endsWith(',') ? rest.slice(0, -1) : rest;
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
  // One entry per line, 4 spaces in (deeper lines are an entry's own options).
  const entries = (key) => {
    const body = new RegExp(`\\n  ${key}:\\s*\\{\\n([\\s\\S]*?)\\n  \\},`).exec(
      text,
    )?.[1];
    return [...(body ?? '').matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
  };
  return {
    approvals: entries('approvals'),
    settings: entries('settings'),
    subject,
    plural,
    table,
    idempotency: choice('idempotency', ['required', 'optional', 'off']),
    clientAccess: clientAccess === 'own' ? 'own' : false,
    grants: choice('grants', ['standard', 'none']) ?? 'standard',
    softDelete: flag('softDelete'),
    unit: flag('unit'),
    fields,
    capabilities: new Set([...caps.matchAll(/'([^']+)'/g)].map((m) => m[1])),
    t: names(plural, kebab(subject)),
  };
}

/** A record declaration's file name: `<item>.record.ts`. */
const RECORD_FILE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.record\.ts$/;

/**
 * A change to who may use the feature (clientAccess, grants) against the
 * committed declaration: the code takes effect on deploy for API clients
 * (clientPermissions are read from the code), but the seed roles are written
 * when a tenant is made, so existing tenants keep their stored roles.
 */
export function permissionWarnings(dir, name, record) {
  // The declaration's file name, in the feature's folder: never a path, never
  // an option of git (#471).
  if (!RECORD_FILE.test(name)) return [];
  let committed;
  try {
    committed = execFileSync(
      'git', // NOSONAR S4036: the developer's git, from PATH (no one fixed path fits macOS and Linux)
      ['show', '--end-of-options', `HEAD:./${name}`],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return []; // new, or not in git: nothing to compare
  }
  const before = readRecordText(committed, path.join(dir, name));
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
  for (const action of before.approvals.filter(
    (name) => !record.approvals.includes(name),
  )) {
    warnings.push(
      `approval ${record.subject}.${action} removed: its route goes (and the OpenAPI document's path: pnpm client:generate), and requests still open for it can no longer be decided or applied: let them end (or cancel them at POST /v1/approvals/{id}/cancel) before you deploy. Its policy versions and settled requests stay in the database.`,
    );
  }
  for (const name of before.settings.filter(
    (setting) => !record.settings.includes(setting),
  )) {
    warnings.push(
      `setting ${name} removed: values administrators stored for it stay in the database and are no longer read; the code that read it must go too.`,
    );
  }
  return warnings;
}

/** `markPaid` → `mark-paid`: an approvable action in its route's path (platform/records/record-approvals.ts). */
export const actionPath = (action) =>
  action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The paths the feature's routes have (the OpenAPI test lists them). */
export function recordPaths(record) {
  const base = `/v1/${record.plural}`;
  const has = (name) => record.capabilities.has(name);
  return [
    base,
    `${base}/{id}`,
    ...(record.softDelete ? [`${base}/{id}/restore`] : []),
    ...(has('bulk') ? [`${base}/bulk`] : []),
    ...(has('attachments')
      ? [
          `${base}/{id}/attachments`,
          `${base}/{id}/attachments/complete`,
          `${base}/{id}/attachments/presign`,
          `${base}/{id}/attachments/sessions`,
          `${base}/{id}/attachments/sessions/{uploadId}`,
          `${base}/{id}/attachments/{attachmentId}/versions`,
        ]
      : []),
    ...(has('comments')
      ? [
          `${base}/{id}/comments`,
          `${base}/{id}/comments/{commentId}`,
          `${base}/{id}/comments/{commentId}/reopen`,
          `${base}/{id}/comments/{commentId}/resolve`,
        ]
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
    ...record.approvals.map((action) => `${base}/{id}/${actionPath(action)}`),
  ];
}

/** The OpenAPI test's sorted path list, with the feature's paths as its declaration has them. */
async function syncPaths(api, record, check) {
  const file = inside(api, 'test/openapi.e2e-spec.ts');
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
    const edited = `${text.slice(0, start)}${block.slice(0, open)}\n${list}\n    ${text.slice(end)}`;
    writeFileSync(file, await format(file, edited));
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
  const root = inside(api, 'src/i18n');
  const locales = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const changes = [];
  const translate = [];
  for (const [namespace, entries] of Object.entries(wanted)) {
    for (const locale of locales) {
      const file = inside(root, locale, `${namespace}.json`);
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
  const journalFile = inside(api, 'drizzle/meta/_journal.json');
  if (!existsSync(journalFile)) return null; // nothing migrated yet
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  const last = journal.entries[journal.entries.length - 1];
  if (!last || !Number.isInteger(last.idx)) return null;
  const snapshotFile = inside(
    api,
    'drizzle/meta',
    `${String(last.idx).padStart(4, '0')}_snapshot.json`,
  );
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
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
  // Taken later: the column is empty (nullable) for the records already there.
  if (record.capabilities.has('numbered') !== Boolean(columns.number))
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

const squash = (text) => text.replace(/\s+/g, ' ').trim();

/** The entries of `<item>.approvals.ts` (its top-level keys, 2 spaces in), with their text. */
function approvalEntries(text) {
  const start = text.indexOf('recordApprovalEffects(');
  const entries = [];
  if (start < 0) return entries;
  const re = /^ {2}(\w+): \{\n[\s\S]*?\n {2}\},\n/gm;
  re.lastIndex = start;
  for (const match of text.matchAll(re)) {
    if (match.index >= start) {
      entries.push({ action: match[1], text: match[0], index: match.index });
    }
  }
  return entries;
}

/**
 * The module's two lines for the approvals' effects (the import and the
 * \`approvals:\` option of recordParts), wired or unwired as the declaration
 * says. Returns the new text, or null when the module isn't in the shape
 * the generator writes (the caller says what to do by hand).
 */
export function wireApprovals(text, t, wanted) {
  const name = `${t.SINGULAR}_APPROVALS`;
  const importLine = `import { ${name} } from './${t.singular}.approvals.js';`;
  const option = `  approvals: ${name},\n`;
  const wired = text.includes(importLine) && text.includes(option);
  if (wanted === wired) return text;
  if (!wanted) {
    return text.replace(`${importLine}\n`, '').replace(option, '');
  }
  const lastImport = [...text.matchAll(/^import .*;$/gm)].pop();
  const call = /(\n {2}schemas: \w+,)(\n\}\);)/.exec(text);
  if (!lastImport || !call) return null;
  const at = lastImport.index + lastImport[0].length;
  return `${text.slice(0, at)}\n${importLine}${text.slice(at)}`.replace(
    /(\n {2}schemas: \w+,)(\n\}\);)/,
    `$1\n${option.trimEnd()}$2`,
  );
}

/**
 * \`<item>.approvals.ts\`: an entry of business logic for each action the
 * declaration has, added as the stub (never touching an entry that exists)
 * and removed only while it is still the stub; the file itself created
 * with the first action and removed with the last. And its wiring in the
 * module.
 */
async function syncApprovals(api, record, check) {
  const { t } = record;
  const dir = inside(api, 'src/features', record.plural);
  const file = inside(dir, `${t.singular}.approvals.ts`);
  const moduleFile = inside(dir, `${t.plural}.module.ts`);
  const changes = [];
  const errors = [];
  const relative = (full) =>
    path.relative(path.join(api, 'src/features'), full);
  const wanted = record.approvals;
  let text = existsSync(file) ? readFileSync(file, 'utf8') : null;

  if (wanted.length && text === null) {
    text = await format(file, templates.approvals({ t, approvals: wanted }));
    changes.push(`${relative(file)}: + the file, with ${wanted.join(', ')}`);
    if (!check) writeFileSync(file, text);
  } else if (text !== null) {
    let edited = text;
    const have = approvalEntries(text);
    for (const entry of [...have].reverse()) {
      if (wanted.includes(entry.action)) continue;
      if (
        squash(entry.text) === squash(templates.approvalEntry(entry.action, t))
      ) {
        edited =
          edited.slice(0, entry.index) +
          edited.slice(entry.index + entry.text.length);
        changes.push(`${relative(file)}: - ${entry.action}`);
      } else {
        errors.push(
          `${relative(file)}: ${entry.action} is no longer in ${t.singular}.record.ts's approvals but its entry holds business logic: move that first, then remove the entry by hand.`,
        );
      }
    }
    for (const action of wanted) {
      if (have.some((entry) => entry.action === action)) continue;
      const close = edited.lastIndexOf('\n});');
      if (close < 0) {
        errors.push(
          `${relative(file)}: no \`});\` to add ${action} before; add its entry by hand.`,
        );
        continue;
      }
      edited = `${edited.slice(0, close)}\n${templates.approvalEntry(action, t)}${edited.slice(close)}`;
      changes.push(`${relative(file)}: + ${action}`);
    }
    if (edited !== text) {
      const remaining = approvalEntries(edited);
      const bare = squash(
        await format(file, templates.approvals({ t, approvals: [] })),
      );
      if (
        !wanted.length &&
        !remaining.length &&
        !errors.length &&
        squash(await format(file, edited)) === bare
      ) {
        changes.push(`${relative(file)}: removed (no approvals left)`);
        if (!check) rmSync(file);
        text = null;
      } else {
        if (!wanted.length && !remaining.length && !errors.length) {
          // Entries gone, but the file holds more than the generator wrote: never lose it.
          errors.push(
            `${relative(file)}: no approvals are left but the file holds more than the generator wrote (imports, helpers): it stays, with no entries; delete it by hand when nothing needs it.`,
          );
        }
        if (!check) writeFileSync(file, await format(file, edited));
        text = edited;
      }
    }
  }

  // The module passes the effects to recordParts while the file stands.
  if (existsSync(moduleFile)) {
    const before = readFileSync(moduleFile, 'utf8');
    const stands = text !== null && wanted.length > 0;
    const after = wireApprovals(before, t, stands);
    if (after === null) {
      errors.push(
        `${relative(moduleFile)}: add \`import { ${t.SINGULAR}_APPROVALS } from './${t.singular}.approvals.js'\` and \`approvals: ${t.SINGULAR}_APPROVALS,\` to its recordParts() options by hand (it isn't in the shape pnpm feature:add writes).`,
      );
    } else if (after !== before) {
      changes.push(
        `${relative(moduleFile)}: ${stands ? '+' : '-'} approvals: ${t.SINGULAR}_APPROVALS`,
      );
      if (!check) writeFileSync(moduleFile, await format(moduleFile, after));
    }
  }
  return { changes, errors };
}

/**
 * One feature: its texts and OpenAPI paths in line (unless `check`), its
 * migration guarded. `plural` is a feature's folder name, never a path.
 */
export async function syncFeature(api, plural, { check = false } = {}) {
  if (!FEATURE_NAME.test(plural)) {
    throw new Error(
      `"${plural}" is not a feature's name (plural, lowercase words joined by "-").`,
    );
  }
  const dir = inside(api, 'src/features', plural);
  const file = readdirSync(dir).find((name) => name.endsWith('.record.ts'));
  if (!file) return null; // a hand-written feature (notes): nothing to sync
  const record = readRecord(inside(dir, file));
  const texts = syncTexts(api, record, check);
  const paths = await syncPaths(api, record, check);
  const approvals = await syncApprovals(api, record, check);
  const { errors, warnings, generate } = guard(api, record);
  warnings.push(...permissionWarnings(dir, file, record));
  return {
    plural,
    changes: [...texts.changes, ...paths, ...approvals.changes],
    translate: texts.translate,
    errors: [...errors, ...approvals.errors, ...handWritten(api, record)],
    warnings,
    generate,
    client: paths.length > 0,
  };
}

/** Every feature with a record declaration. */
export function featureNames(api) {
  const root = inside(api, 'src/features');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      readdirSync(inside(root, name)).some((f) => f.endsWith('.record.ts')),
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
  // --root: this checkout by default, or a copy in a temp directory (checkout()).
  const repo = checkout(values.root ?? REPO, 'apps/api/src/features');
  const api = inside(repo, 'apps/api');
  const features = positionals.length ? positionals : featureNames(api);
  let failed = false;
  for (const plural of features) {
    if (!FEATURE_NAME.test(plural)) {
      console.error(
        `"${plural}" is not a feature's name (plural, lowercase words joined by "-").`,
      );
      failed = true;
      continue;
    }
    if (!existsSync(inside(api, 'src/features', plural))) {
      console.error(`features/${plural} doesn't exist.`);
      failed = true;
      continue;
    }
    const result = await syncFeature(api, plural, { check: values.check });
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
