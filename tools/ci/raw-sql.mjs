#!/usr/bin/env node
// `pnpm lint` runs this (and CI, through raw-sql.test.mjs): the API queries
// through Drizzle's query builder, not raw SQL (AGENTS.md, "No raw SQL";
// #779). It counts, per file of apps/api/src (specs aside), the forms that
// bypass the builder: a whole statement through `.execute(sql`…`)`,
// `sql.raw(…)`, and node-postgres' `pool/client/connection.query(…)`. A file
// may hold only what raw-sql.allow.json grants it, with the reason: a new
// file or a higher count fails, and so does a lower one until the allowlist
// is lowered too, so a conversion can't creep back.
// `sql` fragments inside a builder query (`eq(…)` has no equivalent for
// `lower(x)`, `excluded.x`, `x + 1`) are Drizzle's documented way: not counted.
// Custom code: oxlint has no rule that tells a builder query from raw SQL.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = 'apps/api/src';
const ALLOWLIST = 'tools/ci/raw-sql.allow.json';

const PATTERNS = {
  execute: /\.execute(?:<[^>]*>)?\(\s*sql\s*`/g,
  raw: /\bsql\.raw\(/g,
  query: /\b(?:pool|client|connection)\.query(?:<[^>]*>)?\(/g,
};

// How many raw-SQL forms one source holds.
export function countRaw(source) {
  return Object.values(PATTERNS).reduce(
    (sum, pattern) => sum + (source.match(pattern)?.length ?? 0),
    0,
  );
}

// Every .ts file under `dir`, specs aside, as paths relative to `base`.
export function sources(base = root, dir = join(base, SOURCE)) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(base, path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [relative(base, path)]
      : [];
  });
}

// The files holding raw SQL, and how much.
export function counts(base = root) {
  const out = {};
  for (const file of sources(base)) {
    const n = countRaw(readFileSync(join(base, file), 'utf8'));
    if (n > 0) out[file] = n;
  }
  return out;
}

// What differs from the allowlist, one line per file.
export function compare(found, allowed) {
  const problems = [];
  for (const [file, n] of Object.entries(found)) {
    const granted = allowed[file]?.count ?? 0;
    if (n > granted) {
      problems.push(
        `${file}: ${n} raw SQL (allowed ${granted}): use the query builder`,
      );
    } else if (n < granted) {
      problems.push(
        `${file}: ${n} raw SQL, the allowlist says ${granted}: lower it in ${ALLOWLIST}`,
      );
    }
  }
  for (const file of Object.keys(allowed)) {
    if (!(file in found)) {
      problems.push(`${file}: no raw SQL left: remove it from ${ALLOWLIST}`);
    }
  }
  return problems;
}

export function check(base = root) {
  const allowed = JSON.parse(readFileSync(join(base, ALLOWLIST), 'utf8'));
  return compare(counts(base), allowed);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const problems = check();
  if (problems.length) {
    problems.forEach((p) => process.stderr.write(`raw-sql: ${p}\n`));
    process.stderr.write(
      'raw-sql: write queries with the Drizzle query builder (AGENTS.md, "No raw SQL")\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `raw-sql: ${Object.keys(counts()).length} files hold allowed raw SQL\n`,
    );
  }
}
