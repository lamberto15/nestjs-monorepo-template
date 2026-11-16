#!/usr/bin/env node
// Takes an optional platform capability out (audit item 2.1), as
// tools/feature/remove.mjs takes a feature: `pnpm capability:remove ai`.
// The capabilities it can remove, and what it must know of each beyond the
// conventions, are in tools/feature/removable.mjs. It deletes:
//
// - apps/api/src/platform/<name>/, apps/api/test/<name>.e2e-spec.ts and the
//   manifest's files (its adapters in the notes example and the test
//   fixtures, its other tests);
// - its imports, and the lines naming what they imported (its module, its
//   queue, its settings, its notifications), from the composition files:
//   platform.module.ts, queues/queues.ts, and schema.ts (its tables);
// - every `capability:<name> begin` … `end` block in a shared file (its
//   variables in the env schema, env.example and compose.prod.yaml, its
//   lines in other modules, tests, the wizard and CI): markers are comments
//   only, so a project that removes nothing runs as before;
// - the web app's apps/web/src/features/<name>/, routes/_app/<name>/,
//   locales/<lng>/<name>.json and the manifest's texts, then regenerates the
//   route tree (as feature:remove does);
// - docs/<name>.md and its entry in the docs site's sidebar; a table row
//   whose last cell links to it and a list item that starts with a link to
//   it go, any other link to it becomes its text (listed: review those).
//
// It refuses, listing the files, while anything else still imports what it
// deletes (another capability, a feature, a test), as feature:remove does;
// a second run says there is nothing left to remove.
//
//   pnpm capability:remove ai
//   pnpm capability:remove ai --dry-run                # the plan, nothing changed
//   node --test tools/feature/remove-capability.test.mjs   # its tests
//
// Then: pnpm db:generate (the DROP migration: the command never writes one),
// the `pnpm remove` it prints for the packages only the capability used,
// pnpm client:generate, and the checks (docs/adding-a-feature.md, "Removing a
// platform capability").
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
import { markdownLinks } from '../docs/links.mjs';
import { format } from './format.mjs';
import { checkout, inside } from './paths.mjs';
import { REMOVABLE } from './removable.mjs';
import {
  deleteKey,
  literal,
  regenerateRouteTree,
  stripBlocks,
  stripImports,
  walk,
  webPaths,
} from './remove.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** The files that compose the platform: a capability's imports and the lines naming them go from these. */
const COMPOSITION = [
  'apps/api/src/platform/platform.module.ts',
  'apps/api/src/platform/queues/queues.ts',
  'apps/api/src/schema.ts',
];

/** Where the marker blocks are looked for: every text file but these folders'. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.turbo',
  'dist',
  'coverage',
  'drizzle',
  'playwright-report',
  'test-results',
]);
const MARKED = [
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.yaml',
  '.yml',
  '.example',
  '.dockerignore',
  'Dockerfile',
];

/** The files under `dir` that may hold markers, as absolute paths. */
function markable(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markable(file));
    else if (MARKED.some((e) => entry.name.endsWith(e))) found.push(file);
  }
  return found;
}

const noExtension = (file) => file.replace(/\.(?:[cm]?js|tsx?)$/, '');

/** Whether `file` is, or is under, one of `deleted` (absolute paths). */
const isDeleted = (file, deleted) =>
  deleted.some(
    (d) =>
      file === d ||
      file.startsWith(d + path.sep) ||
      noExtension(file) === noExtension(d),
  );

/** The files a TypeScript file imports (or mocks), resolved: relative and `@/` (the web app's src) specifiers. */
function importsOf(file, text, webSrc) {
  const found = [];
  for (const [, spec] of text.matchAll(
    /(?:\bfrom|\bimport|\bmock)\s*\(?\s*'([^']+)'/g,
  )) {
    if (spec.startsWith('.'))
      found.push(path.resolve(path.dirname(file), spec));
    else if (spec.startsWith('@/') && file.startsWith(webSrc + path.sep)) {
      found.push(path.join(webSrc, spec.slice(2)));
    }
  }
  return found;
}

/** A Markdown table row's last cell (`| a | b |` → ` b `). */
const lastCell = (line) => line.trim().replace(/\|$/, '').split('|').at(-1);

/**
 * A Markdown file without its entries for the deleted pages: a table row
 * whose last cell links to one, a list item that starts with a link to one
 * (with its continuation lines). Other links to them become their text.
 */
function stripDocLinks(file, text, pages) {
  const toPage = (href) =>
    !/^(?:#|[a-z][\w+.-]*:|\/\/)/i.test(href) &&
    pages.includes(
      path.resolve(
        path.dirname(file),
        decodeURIComponent(href.split(/[?#]/)[0]),
      ),
    );
  const lines = text.split('\n');
  const out = [];
  const unlinked = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker)
      fence = fence ? (fence === marker[1][0] ? '' : fence) : marker[1][0];
    const hrefs =
      fence || marker ? [] : [...markdownLinks(line)].filter(toPage);
    if (hrefs.length === 0) {
      out.push(line);
      continue;
    }
    if (
      /^\s*\|/.test(line) &&
      [...markdownLinks(lastCell(line))].some(toPage)
    ) {
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+\.)\s+\[[^\]]*\]\(([^)\s]+)/.exec(line);
    if (item && toPage(item[2])) {
      // Its continuation lines (and nested items): indented further.
      const indent = (next) => next.length - next.trimStart().length;
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        indent(lines[i + 1]) > item[1].length
      ) {
        i += 1;
      }
      continue;
    }
    let kept = line;
    for (const href of hrefs) {
      kept = kept.replace(
        new RegExp(
          `\\[([^\\]]*)\\]\\(${literal(href)}(?:\\s+"[^"]*")?\\)`,
          'g',
        ),
        '$1',
      );
    }
    unlinked.push(i + 1);
    out.push(kept);
  }
  return { out: out.join('\n'), unlinked };
}

/**
 * Markdown without the section under `heading` (`## Record presence`): the
 * heading line up to the next heading of its level or above, outside code
 * fences. Null when the heading isn't there.
 */
function stripSection(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  let end = start + 1;
  let fence = '';
  for (; end < lines.length; end++) {
    const marker = /^\s*(\`{3,}|~{3,})/.exec(lines[end]);
    if (marker)
      fence = fence ? (fence === marker[1][0] ? '' : fence) : marker[1][0];
    const next = !fence && /^(#+) /.exec(lines[end]);
    if (next && next[1].length <= level) break;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/**
 * Removes the capability `options.name` under `root`. Returns what was
 * (or, with `dryRun`, would be) removed, relative to `root`, and what to
 * run next; `nothing` when it is gone already. Throws before changing
 * anything when the name isn't a supported capability, `root` isn't a
 * checkout, or something else still imports what it deletes.
 */
export async function removeCapability(root, options) {
  const name = options.name;
  const repo = checkout(root, 'apps/api/src/platform');
  if (typeof name !== 'string' || !Object.hasOwn(REMOVABLE, name)) {
    throw new Error(
      `"${name}" is not a capability this command can remove; it removes ${Object.keys(REMOVABLE).join(', ')} (tools/feature/removable.mjs).`,
    );
  }
  const spec = REMOVABLE[name];
  const tag = `capability:${name}`;
  const api = inside(repo, 'apps/api');
  const webSrc = inside(repo, 'apps/web/src');
  const folder = inside(api, 'src/platform', name);
  const page = inside(repo, 'docs', `${name}.md`);

  const deletions = [
    folder,
    inside(api, 'test', `${name}.e2e-spec.ts`),
    ...(spec.files ?? []).map((file) => inside(repo, file)),
    ...(existsSync(webSrc) ? webPaths(webSrc, name) : []),
    page,
  ].filter((file) => existsSync(file));

  // Every edit is computed first, so a refusal leaves the tree as it was.
  const edits = new Map(); // file → new text
  const removed = [];
  const current = (file) => edits.get(file) ?? readFileSync(file, 'utf8');
  const change = (file, text, what) => {
    edits.set(file, text);
    removed.push(`${what} in ${path.relative(repo, file)}`);
  };

  for (const file of markable(repo)) {
    if (isDeleted(file, deletions)) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes(`${tag} begin`)) continue;
    const { out, count } = stripBlocks(text, tag);
    if (count) change(file, out, `${count} ${tag} block(s)`);
  }
  for (const relative of COMPOSITION) {
    const file = inside(repo, relative);
    if (!existsSync(file)) continue;
    let prefix = path.relative(path.dirname(file), folder) + '/';
    if (!prefix.startsWith('.')) prefix = `./${prefix}`;
    const text = current(file);
    const out = stripImports(text, prefix);
    if (out !== text) change(file, out, 'its imports and lines');
  }

  // Anything left that imports what goes refuses the removal.
  const sources = [
    inside(api, 'src'),
    inside(api, 'test'),
    ...(existsSync(webSrc) ? [webSrc] : []),
  ].filter((dir) => existsSync(dir));
  const offenders = sources
    .flatMap((dir) => walk(dir, '.ts', '.tsx'))
    .filter((file) => !isDeleted(file, deletions))
    // Generated from the routes left: regenerated after the removal.
    .filter((file) => path.basename(file) !== 'routeTree.gen.ts')
    .filter((file) =>
      importsOf(file, current(file), webSrc).some((target) =>
        isDeleted(target, deletions),
      ),
    )
    .map((file) => path.relative(repo, file));
  if (offenders.length) {
    throw new Error(
      `Other files still import from ${name}; remove those uses first (or mark the lines \`// ${tag} begin\` … \`end\`):\n${offenders.map((f) => `  ${f}`).join('\n')}`,
    );
  }

  // Its texts in shared locale files.
  for (const { app, file, key } of spec.texts ?? []) {
    const locales = inside(
      repo,
      app === 'api' ? 'apps/api/src/i18n' : 'apps/web/src/locales',
    );
    if (!existsSync(locales)) continue;
    for (const lng of readdirSync(locales, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)) {
      const json = inside(locales, lng, file);
      if (!existsSync(json)) continue;
      const data = JSON.parse(current(json));
      if (!deleteKey(data, key)) continue;
      change(json, `${JSON.stringify(data, null, 2)}\n`, `"${key.join('.')}"`);
    }
  }

  // Its docs: the page's sidebar entry, its rows and items, links to it.
  const unlinked = [];
  if (deletions.includes(page)) {
    const sidebar = inside(repo, 'docs/.vitepress/config.mjs');
    if (existsSync(sidebar)) {
      const text = current(sidebar);
      const out = text.replace(
        new RegExp(`^[ \\t]*\\[[^\\]\\n]*'/${literal(name)}'\\],\\n`, 'gm'),
        '',
      );
      if (out !== text) change(sidebar, out, 'its sidebar entry');
    }
    const markdown = [
      ...['README.md', 'AGENTS.md', 'apps/api/AGENTS.md', 'apps/web/AGENTS.md']
        .map((file) => inside(repo, file))
        .filter((file) => existsSync(file)),
      ...(existsSync(inside(repo, 'docs'))
        ? walk(inside(repo, 'docs'), '.md')
        : []),
    ].filter((file) => !isDeleted(file, deletions));
    for (const file of markdown) {
      const text = current(file);
      const { out, unlinked: lines } = stripDocLinks(file, text, [page]);
      if (out === text) continue;
      change(file, out, 'its links');
      for (const line of lines)
        unlinked.push(`${path.relative(repo, file)}:${line}`);
    }
  }

  // Its sections in shared docs pages: a heading and what is under it.
  for (const [relative, heading] of spec.sections ?? []) {
    const file = inside(repo, relative);
    const before = existsSync(file) ? current(file) : '';
    const out = stripSection(before, heading);
    if (out !== null) change(file, out, `"${heading}"`);
    else if (deletions.includes(folder)) {
      throw new Error(
        `${relative} has no "${heading}" heading (tools/feature/removable.mjs, ${name}.sections): update the manifest.`,
      );
    }
  }

  // The prose a marker can't hold.
  for (const [relative, text, replacement] of spec.edits ?? []) {
    const file = inside(repo, relative);
    const before = existsSync(file) ? current(file) : '';
    const found = before.split(text).length - 1;
    if (found === 1) {
      change(
        file,
        before.replace(text, () => replacement),
        'its mention',
      );
    } else if (found > 1 || deletions.includes(folder)) {
      throw new Error(
        `${relative} holds "${text}" ${found} times, not once (tools/feature/removable.mjs, ${name}.edits): update the manifest.`,
      );
    }
  }

  if (deletions.length === 0 && edits.size === 0) return { nothing: true };

  for (const [file, text] of edits) {
    edits.set(
      file,
      /\.(?:tsx?|mjs)$/.test(file) ? await format(file, text) : text,
    );
  }
  if (!options.dryRun) {
    for (const [file, text] of edits) writeFileSync(file, text);
    for (const file of deletions) rmSync(file, { recursive: true });
  }
  return {
    nothing: false,
    deleted: deletions.map((file) => path.relative(repo, file)),
    removed,
    unlinked,
    dependencies: spec.dependencies ?? {},
    tables: removed.some((r) => r.endsWith('apps/api/src/schema.ts')),
  };
}

const USAGE = `pnpm capability:remove <name> [--dry-run]; <name> is one of ${Object.keys(REMOVABLE).join(', ')}`;

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
  // --root: this checkout by default, or a copy in a temp directory (checkout()).
  const root = values.root ?? REPO;
  const dryRun = values['dry-run'];
  const result = await removeCapability(root, { name, dryRun });
  if (result.nothing) {
    return console.log(
      `Nothing to remove: capability ${name} is gone already.`,
    );
  }
  console.log(
    `${dryRun ? 'Would remove' : 'Removed'} capability ${name}, ${REMOVABLE[name].about}:`,
  );
  for (const file of result.deleted) console.log(`  - ${file}`);
  for (const change of result.removed) console.log(`  ~ ${change}`);
  if (result.unlinked.length) {
    console.log('\nLinks to its page made plain text; review those lines:');
    for (const line of result.unlinked) console.log(`  ${line}`);
  }
  if (dryRun) return console.log('\nDry run: nothing changed.');
  if (await regenerateRouteTree(root))
    console.log('  ~ apps/web/src/routeTree.gen.ts (regenerated)');
  const packages = Object.entries(result.dependencies).map(
    ([pkg, deps]) =>
      `  pnpm --filter ${pkg} remove ${deps.join(' ')}   # used by ${name} only`,
  );
  console.log(`
Next:
${result.tables ? '  pnpm db:generate        # writes the DROP migration of its tables; on a live project that is an expand/contract change (docs/development.md)\n' : ''}${packages.map((line) => `${line}\n`).join('')}  pnpm client:generate    # the typed client, without its routes
  pnpm build && pnpm lint && pnpm test`);
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
