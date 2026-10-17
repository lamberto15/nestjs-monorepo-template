#!/usr/bin/env node
// Takes a feature out, the counterpart of tools/feature/add.mjs: deletes its
// folder and e2e tests, drops its lines from features/index.ts,
// features/tables.ts and features/env.ts, its PDF template and its texts
// (the `<item>` key of every locale file), and its block in env.example
// (between `# feature:<name> begin` and `# feature:<name> end`). It refuses
// while another feature imports from the folder (a `ref(...)` to its table).
//
//   pnpm feature:remove notes
//   pnpm feature:remove notes --dry-run          # the plan, nothing changed
//   node --test tools/feature/remove.test.mjs    # its tests
//
// Then: pnpm db:generate (drops the table: on a live project that is an
// expand/contract change, docs/development.md), pnpm client:generate, and
// the check before every commit (CLAUDE.md).
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
import { format } from './format.mjs';
import { names, singularize } from './names.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** The barrels a feature is listed in; they may import it. */
const BARRELS = ['index.ts', 'tables.ts', 'env.ts'];

/** All files under `dir` with the extension, as absolute paths. */
function walk(dir, extension) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(file, extension));
    else if (file.endsWith(extension)) found.push(file);
  }
  return found;
}

/**
 * The item key (`note`): the `<item>.resource.ts` the folder holds (which
 * also covers a hand-written feature), else what names.mjs derives.
 */
function itemKey(dir, plural) {
  const resources = readdirSync(dir).filter((f) => f.endsWith('.resource.ts'));
  if (resources.length === 1) {
    return resources[0].replace(/\.resource\.ts$/, '');
  }
  return singularize(plural) ?? names(plural).singular;
}

/** A barrel without the imports from `./<name>/` and the lines using them. */
function stripBarrel(text, plural) {
  const identifiers = [];
  const imports = new RegExp(
    `^import [^;]*?from '\\./${plural}/[^']*';\\n`,
    'gm',
  );
  let out = text.replace(imports, (statement) => {
    const clause = statement.match(/^import \{([^}]*)\}/);
    for (const part of clause?.[1].split(',') ?? []) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) identifiers.push(name);
    }
    return '';
  });
  out = out.replace(
    new RegExp(`^export [^;]*?from '\\./${plural}/[^']*';\\n`, 'gm'),
    '',
  );
  for (const id of identifiers) {
    // A list entry (`NOTES_FEATURE,`) or a spread (`...notesEnv.shape,`).
    out = out.replace(
      new RegExp(`^[ \\t]*(\\.\\.\\.)?${id}(\\.shape)?,\\n`, 'gm'),
      '',
    );
    if (new RegExp(`\\b${id}\\b`).test(out)) {
      throw new Error(
        `${id} is still used after removing the import of ./${plural}/: remove that use by hand.`,
      );
    }
  }
  return out;
}

/**
 * A file without every `feature:<name> begin … end` block, marked by `#`
 * comments (env files) or `//` comments (test/setup-env.ts).
 */
function stripEnvBlocks(text, plural) {
  const block = new RegExp(
    `^[ \\t]*(?:#|//) feature:${plural} begin\\n[\\s\\S]*?^[ \\t]*(?:#|//) feature:${plural} end\\n`,
    'gm',
  );
  const count = text.match(block)?.length ?? 0;
  const out = text.replace(block, '').replace(/\n\n\n+/g, '\n\n');
  return { out, count };
}

/**
 * Removes the feature under `root`. Returns what was (or, with `dryRun`,
 * would be) removed, relative to `root`; throws before changing anything
 * when the feature is missing or another one uses it. The TypeScript it
 * edits is formatted as `pnpm format` would.
 */
export async function removeFeature(root, options) {
  const plural = options.name;
  const api = path.join(root, 'apps/api');
  const features = path.join(api, 'src/features');
  const dir = path.join(features, plural);
  if (!/^[a-z][a-z0-9-]*$/.test(plural) || !existsSync(dir)) {
    throw new Error(`There is no features/${plural}.`);
  }
  const offenders = walk(features, '.ts')
    .filter((file) => !file.startsWith(dir + path.sep))
    .filter(
      (file) =>
        !(
          path.dirname(file) === features &&
          BARRELS.includes(path.basename(file))
        ),
    )
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes(`'../${plural}/`) || text.includes(`'./${plural}/`);
    })
    .map((file) => path.relative(root, file));
  if (offenders.length) {
    throw new Error(
      `Other files import from features/${plural}; remove those uses first (a ref(${plural}) field, for one):\n${offenders.map((f) => `  ${f}`).join('\n')}`,
    );
  }
  const item = itemKey(dir, plural);

  // Compute every edit first, so a failure leaves the tree as it was.
  const edits = []; // [file, new text]
  const removed = [];
  for (const name of BARRELS) {
    const file = path.join(features, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const stripped = stripBarrel(text, plural);
    if (stripped !== text) {
      edits.push([file, await format(file, stripped)]);
      removed.push(`lines in ${path.relative(root, file)}`);
    }
  }
  // Its variables: the deployment's template, the development one, the tests'.
  for (const file of [
    path.join(root, 'env.example'),
    path.join(api, 'env.development.example'),
    path.join(api, 'test/setup-env.ts'),
  ]) {
    if (!existsSync(file)) {
      continue;
    }
    const { out, count } = stripEnvBlocks(readFileSync(file, 'utf8'), plural);
    if (count) {
      edits.push([file, file.endsWith('.ts') ? await format(file, out) : out]);
      removed.push(
        `${count} feature:${plural} block(s) in ${path.relative(root, file)}`,
      );
    }
  }
  const i18n = path.join(api, 'src/i18n');
  if (existsSync(i18n)) {
    for (const file of walk(i18n, '.json')) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      if (!Object.hasOwn(json, item)) continue;
      delete json[item];
      edits.push([file, `${JSON.stringify(json, null, 2)}\n`]);
      removed.push(`"${item}" in ${path.relative(root, file)}`);
    }
  }
  const deletions = [
    dir,
    path.join(api, 'test', `${plural}.e2e-spec.ts`),
    path.join(api, 'test/features', plural),
    path.join(api, 'src/documents/templates', `${item}.html`),
  ].filter((file) => existsSync(file));

  if (!options.dryRun) {
    for (const [file, text] of edits) writeFileSync(file, text);
    for (const file of deletions) rmSync(file, { recursive: true });
  }
  return {
    item,
    deleted: deletions.map((file) => path.relative(root, file)),
    removed,
  };
}

const USAGE = 'pnpm feature:remove <plural-name> [--dry-run]';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const name = positionals[0];
  const result = await removeFeature(path.resolve(values.root ?? REPO), {
    name,
    dryRun: values['dry-run'],
  });
  console.log(
    `${values['dry-run'] ? 'Would remove' : 'Removed'} features/${name} (item "${result.item}"):`,
  );
  for (const file of result.deleted) console.log(`  - ${file}`);
  for (const change of result.removed) console.log(`  ~ ${change}`);
  if (values['dry-run']) return console.log('\nDry run: nothing changed.');
  console.log(`
Next:
  pnpm db:generate        # drops the table; on a live project that is an expand/contract change (docs/development.md)
  pnpm client:generate    # the typed client
  pnpm lint && pnpm build && pnpm test`);
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
