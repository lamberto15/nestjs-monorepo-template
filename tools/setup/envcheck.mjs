#!/usr/bin/env node
// Checks an env file against its template, by name: the variables the
// template has and the file lacks (the app runs with its defaults for those,
// silently), the ones the file has and the template does not name, and the
// REQUIRED ones that are empty. Exit code 1 when a REQUIRED one is empty (the
// stack would not start, or would run with a placeholder); with --strict also
// when any variable is missing. Nothing is written: `pnpm setup` adds the
// missing ones (with the template's defaults) on a re-run.
//
//   pnpm env:check                       # .env and apps/api/.env.development, whichever exist
//   pnpm env:check --target production --strict
//   pnpm env:check --file /secure/prod.env --target production
//   pnpm env:check --templates           # the templates themselves (CI): no name twice, REQUIRED ones named
//   node --test tools/setup/envcheck.test.mjs   # its tests
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  duplicateKeys,
  missingKeys,
  parseEnv,
  TARGETS,
  templateKeys,
  unknownKeys,
} from './envfile.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * The variables a target cannot start without: each is a list of names, one
 * of which must be set (the variable, or its _FILE, or the managed
 * PostgreSQL's URL that replaces it). `placeholder` is a value that counts as
 * not set. These are the "Required" lines of env.example and of
 * docs/deployment.md, "Production with Docker Compose".
 */
export const REQUIRED = {
  production: [
    { any: ['APP_DOMAIN'], placeholder: 'api.example.com' },
    { any: ['ACME_EMAIL'] },
    { any: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN_FILE'] },
    {
      any: [
        'POSTGRES_PASSWORD',
        'POSTGRES_PASSWORD_FILE',
        'DATABASE_OWNER_URL',
        'DATABASE_OWNER_URL_FILE',
      ],
    },
    {
      any: ['POSTGRES_APP_PASSWORD', 'DATABASE_URL', 'DATABASE_URL_FILE'],
    },
    { any: ['MFA_ENCRYPTION_KEYS', 'MFA_ENCRYPTION_KEYS_FILE'] },
    { any: ['DATA_ENCRYPTION_KEYS', 'DATA_ENCRYPTION_KEYS_FILE'] },
    { any: ['BLIND_INDEX_KEYS', 'BLIND_INDEX_KEYS_FILE'] },
  ],
  // The app refuses to start without the encrypted columns' keys.
  development: [
    { any: ['DATA_ENCRYPTION_KEYS', 'DATA_ENCRYPTION_KEYS_FILE'] },
    { any: ['BLIND_INDEX_KEYS', 'BLIND_INDEX_KEYS_FILE'] },
  ],
};

/** A requirement as the report names it: `NAME (or OTHER, ...)`. */
const label = ({ any }) =>
  any.length > 1 ? `${any[0]} (or ${any.slice(1).join(', ')})` : any[0];

/** The requirements of `target` that `env` (a Map) does not meet. */
export function emptyRequired(target, env) {
  return REQUIRED[target].filter(
    (requirement) =>
      !requirement.any.some((name) => {
        const value = env.get(name) ?? '';
        return value !== '' && value !== requirement.placeholder;
      }),
  );
}

/** The findings for a file: { missing, unknown, repeated, empty (the unmet requirements) }. */
export function compareEnv(target, templateText, fileText) {
  return {
    missing: missingKeys(templateText, fileText).map(({ key }) => key),
    unknown: unknownKeys(templateText, fileText),
    repeated: duplicateKeys(fileText),
    empty: emptyRequired(target, parseEnv(fileText)),
  };
}

/** The findings for a template itself: a name set twice, a REQUIRED one it does not name. */
export function checkTemplate(target, templateText) {
  const named = templateKeys(templateText);
  return {
    repeated: duplicateKeys(templateText),
    unnamed: REQUIRED[target].filter(
      (requirement) => !requirement.any.some((name) => named.has(name)),
    ),
  };
}

const USAGE = `pnpm env:check [--target development|production] [options]

  --target <t>   check only that target's file (default: .env and apps/api/.env.development, whichever exist)
  --file <path>  check this file (with --target, default production) instead of the target's own
  --strict       also exit 1 when the template has variables the file lacks
  --templates    check the templates themselves (no variable set twice, the REQUIRED ones named)
  --root <dir>   the repository (default: this one)`;

/** Names, wrapped to `width` columns, indented. */
function wrap(names, indent = '    ', width = 96) {
  const rows = [];
  let row = '';
  for (const name of names) {
    const next = row ? `${row}, ${name}` : name;
    if (row && indent.length + next.length > width) {
      rows.push(`${row},`);
      row = name;
    } else row = next;
  }
  if (row) rows.push(row);
  return rows.map((r) => `${indent}${r}`).join('\n');
}

/** Runs the check. `io` is for tests: { out, err }. Returns the exit code. */
export function run(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      file: { type: 'string' },
      root: { type: 'string' },
      strict: { type: 'boolean', default: false },
      templates: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (values.target !== undefined && !TARGETS[values.target]) {
    throw new Error('--target: development or production.');
  }
  const root = path.resolve(values.root ?? REPO);
  const targets = values.target
    ? [values.target]
    : values.file
      ? ['production']
      : ['production', 'development'];
  const readTemplate = (target) => {
    const templatePath = path.join(root, TARGETS[target].template);
    if (!existsSync(templatePath)) {
      throw new Error(
        `The template ${TARGETS[target].template} is not under ${root}.`,
      );
    }
    return readFileSync(templatePath, 'utf8');
  };

  if (values.templates) {
    let failed = false;
    for (const target of targets) {
      const found = checkTemplate(target, readTemplate(target));
      const name = TARGETS[target].template;
      if (!found.repeated.length && !found.unnamed.length) {
        out(`${name}: ok.`);
        continue;
      }
      failed = true;
      if (found.repeated.length) {
        err(`${name}: set more than once: ${found.repeated.join(', ')}.`);
      }
      for (const requirement of found.unnamed) {
        err(`${name}: does not name the REQUIRED ${label(requirement)}.`);
      }
    }
    return failed ? 1 : 0;
  }

  let checked = 0;
  let failed = false;
  for (const target of targets) {
    const filePath = values.file
      ? path.resolve(values.file)
      : path.join(root, TARGETS[target].file);
    const relative = path.relative(process.cwd(), filePath);
    const shown = relative && !relative.startsWith('..') ? relative : filePath;
    if (!existsSync(filePath)) {
      // A file named (or a single target asked for) must be there; the default scan skips the one it does not find.
      if (values.file || values.target) {
        err(
          `${shown} does not exist (pnpm setup --target ${target} writes it).`,
        );
        failed = true;
      }
      continue;
    }
    checked++;
    const templateName = TARGETS[target].template;
    const found = compareEnv(
      target,
      readTemplate(target),
      readFileSync(filePath, 'utf8'),
    );
    const problems =
      found.empty.length > 0 || (values.strict && found.missing.length > 0);
    failed ||= problems;
    out(`${shown} (${target}), against ${templateName}:`);
    if (
      !found.missing.length &&
      !found.unknown.length &&
      !found.repeated.length &&
      !found.empty.length
    ) {
      out('  ok: every variable is there, every REQUIRED one is set.');
      continue;
    }
    for (const requirement of found.empty) {
      out(
        `  REQUIRED, empty${requirement.placeholder ? ` or ${requirement.placeholder}` : ''}: ${label(requirement)}`,
      );
    }
    if (found.missing.length) {
      out(
        `  ${found.missing.length} variable${found.missing.length > 1 ? 's' : ''} of ${templateName} not in the file (the app runs with its defaults for them; pnpm setup adds them with the template's defaults):`,
      );
      out(wrap(found.missing));
    }
    if (found.unknown.length) {
      out(
        `  ${found.unknown.length} variable${found.unknown.length > 1 ? 's' : ''} the template does not name (a typo, a removed one, or an optional one it does not list; docs/configuration.md):`,
      );
      out(wrap(found.unknown));
    }
    if (found.repeated.length) {
      out(`  set more than once, leave one: ${found.repeated.join(', ')}`);
    }
  }
  if (!checked && !failed) {
    err(
      `No env file to check (${targets.map((t) => TARGETS[t].file).join(', ')}): pnpm setup writes one.`,
    );
    return 1;
  }
  return failed ? 1 : 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
