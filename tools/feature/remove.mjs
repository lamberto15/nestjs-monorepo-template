#!/usr/bin/env node
// Takes a feature out, the counterpart of tools/feature/add.mjs: deletes its
// folder and e2e tests, drops its lines from features/index.ts,
// features/tables.ts and features/env.ts, its PDF template and its texts
// (the `<item>` key of every locale file), and its block in env.example
// (between `# feature:<name> begin` and `# feature:<name> end`). It refuses
// while another feature imports from the folder (a `ref(...)` to its table).
//
// The web app's part goes with it, found by the paths docs/monorepo.md
// ("Adding a page for a feature") gives every feature: apps/web/src/
// features/<name>/ (its nav entry is the folder's nav.ts),
// routes/_app/<name>/, locales/<lng>/<name>.json, and its texts in the
// shared namespaces (WEB_TEXTS). It refuses while another web file imports
// from features/<name>/. Either side may be gone already: a project that
// removed the API's part before keeps the web's removable.
//
//   pnpm feature:remove notes
//   pnpm feature:remove notes --dry-run          # the plan, nothing changed
//   node --test tools/feature/remove.test.mjs    # its tests
//
// Then: pnpm db:generate (drops the table: on a live project that is an
// expand/contract change, docs/development.md), pnpm client:generate, and
// the check before every commit (CLAUDE.md). `pnpm build` comes first: the
// web's build regenerates its route tree (src/routeTree.gen.ts, the TanStack
// Router plugin's) before it type-checks, and the tests import that tree.
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
import { checkout, FEATURE_NAME, inside } from './paths.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** The barrels a feature is listed in; they may import it. */
const BARRELS = ['index.ts', 'tables.ts', 'env.ts'];

/**
 * A feature's texts in the web's shared namespaces (locales/<lng>/<file>),
 * as key paths: the search palette's group name, the settings page's group,
 * its approval actions' names.
 */
const WEB_TEXTS = [
  { file: 'search.json', key: ({ Subject }) => ['subjects', Subject] },
  { file: 'settings.json', key: ({ plural }) => ['groups', plural] },
  { file: 'approvals.json', key: ({ Subject }) => ['actions', Subject] },
];

/** All files under `dir` with one of the extensions, as absolute paths. */
function walk(dir, ...extensions) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(file, ...extensions));
    else if (extensions.some((e) => file.endsWith(e))) found.push(file);
  }
  return found;
}

/** `invoice-line` → `InvoiceLine`: the permission subject. */
const pascal = (kebab) =>
  kebab
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('');

/** `json` without the key path; false when it had none. */
function deleteKey(json, keys) {
  const parent = keys
    .slice(0, -1)
    .reduce(
      (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
      json,
    );
  const last = keys.at(-1);
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, last)) {
    return false;
  }
  delete parent[last];
  return true;
}

/** The web app's files of the feature (relative to `web`), those that exist. */
function webPaths(web, plural) {
  const locales = inside(web, 'locales');
  return [
    inside(web, 'features', plural),
    inside(web, 'routes/_app', plural),
    inside(web, 'routes/_app', `${plural}.tsx`),
    ...(existsSync(locales)
      ? readdirSync(locales).map((lng) =>
          inside(locales, lng, `${plural}.json`),
        )
      : []),
  ].filter((file) => existsSync(file));
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
 * when the feature is missing or another one uses it, `root` isn't a
 * checkout, or the name isn't a feature's (a path never is). The TypeScript
 * it edits is formatted as `pnpm format` would.
 */
export async function removeFeature(root, options) {
  const plural = options.name;
  const repo = checkout(root, 'apps/api/src/features', 'apps/web/src/features');
  if (typeof plural !== 'string' || !FEATURE_NAME.test(plural)) {
    throw new Error(
      `"${plural}" is not a feature's name (plural, lowercase words joined by "-"): there is no features/${plural}.`,
    );
  }
  const api = inside(repo, 'apps/api');
  const features = inside(api, 'src/features');
  const dir = inside(features, plural);
  const web = inside(repo, 'apps/web/src');
  const hasApi = existsSync(dir);
  const webFiles = existsSync(web) ? webPaths(web, plural) : [];
  if (!hasApi && webFiles.length === 0) {
    throw new Error(`There is no features/${plural}.`);
  }
  const offenders = (hasApi ? walk(features, '.ts') : [])
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
    .map((file) => path.relative(repo, file));
  if (offenders.length) {
    throw new Error(
      `Other files import from features/${plural}; remove those uses first (a ref(${plural}) field, for one):\n${offenders.map((f) => `  ${f}`).join('\n')}`,
    );
  }
  // The web's: a page or a shared file built on the feature's queries.
  const webOffenders = (webFiles.length ? walk(web, '.ts', '.tsx') : [])
    .filter(
      (file) =>
        !webFiles.some((p) => file === p || file.startsWith(p + path.sep)),
    )
    .filter((file) =>
      readFileSync(file, 'utf8').includes(`'@/features/${plural}/`),
    )
    .map((file) => path.relative(repo, file));
  if (webOffenders.length) {
    throw new Error(
      `Other web files import from features/${plural}; remove those uses first:\n${webOffenders.map((f) => `  ${f}`).join('\n')}`,
    );
  }
  const item = hasApi
    ? itemKey(dir, plural)
    : (singularize(plural) ?? names(plural).singular);

  // Compute every edit first, so a failure leaves the tree as it was.
  const edits = []; // [file, new text]
  const removed = [];
  for (const name of hasApi ? BARRELS : []) {
    const file = path.join(features, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const stripped = stripBarrel(text, plural);
    if (stripped !== text) {
      edits.push([file, await format(file, stripped)]);
      removed.push(`lines in ${path.relative(repo, file)}`);
    }
  }
  // Its variables: the deployment's template, the development one, the tests'.
  for (const file of [
    inside(repo, 'env.example'),
    inside(api, 'env.development.example'),
    inside(api, 'test/setup-env.ts'),
  ]) {
    if (!existsSync(file)) {
      continue;
    }
    const { out, count } = stripEnvBlocks(readFileSync(file, 'utf8'), plural);
    if (count) {
      edits.push([file, file.endsWith('.ts') ? await format(file, out) : out]);
      removed.push(
        `${count} feature:${plural} block(s) in ${path.relative(repo, file)}`,
      );
    }
  }
  const i18n = inside(api, 'src/i18n');
  if (existsSync(i18n)) {
    for (const file of walk(i18n, '.json')) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      if (!Object.hasOwn(json, item)) continue;
      delete json[item];
      edits.push([file, `${JSON.stringify(json, null, 2)}\n`]);
      removed.push(`"${item}" in ${path.relative(repo, file)}`);
    }
  }
  const locales = inside(web, 'locales');
  if (existsSync(locales)) {
    const forms = { plural, Subject: pascal(item) };
    for (const lng of readdirSync(locales)) {
      for (const text of WEB_TEXTS) {
        const file = inside(locales, lng, text.file);
        if (!existsSync(file)) continue;
        const json = JSON.parse(readFileSync(file, 'utf8'));
        const keys = text.key(forms);
        if (!deleteKey(json, keys)) continue;
        edits.push([file, `${JSON.stringify(json, null, 2)}\n`]);
        removed.push(`"${keys.join('.')}" in ${path.relative(repo, file)}`);
      }
    }
  }
  const deletions = [
    ...(hasApi
      ? [
          dir,
          inside(api, 'test', `${plural}.e2e-spec.ts`),
          inside(api, 'test/features', plural),
          inside(api, 'src/documents/templates', `${item}.html`),
        ]
      : []),
    ...webFiles,
  ].filter((file) => existsSync(file));

  if (!options.dryRun) {
    for (const [file, text] of edits) writeFileSync(file, text);
    for (const file of deletions) rmSync(file, { recursive: true });
  }
  return {
    item,
    deleted: deletions.map((file) => path.relative(repo, file)),
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
  // --root: a checkout of the template (removeFeature checks it), this one by default.
  const result = await removeFeature(values.root ?? REPO, {
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
  pnpm build              # first: the web's build regenerates its route tree (src/routeTree.gen.ts)
  pnpm lint && pnpm test`);
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
