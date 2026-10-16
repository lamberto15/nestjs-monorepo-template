#!/usr/bin/env node
// The notes of a template release (docs/releases.md): what an adopter or a
// deployer needs before taking a `v*` tag, then GitHub's generated list of
// pull requests. Generated from git alone, between the tag and the release
// before it:
//
// - breaking changes: commits whose subject has `!` or whose body has
//   `BREAKING CHANGE:` (Conventional Commits);
// - the published images, by version (and digest, when CI passes them);
// - the migrations added under apps/api/drizzle/, with the expand/contract
//   lint's findings (tools/migration-lint, squawk in Docker): what would break
//   the previous release on this schema;
// - rolling back: the previous release's images, valid only under the
//   expand/contract policy (docs/pitfalls.md), and the Compose files to roll
//   back with them;
// - variables added to or removed from env.example, and the typed client's
//   version.
//
//   node tools/release/notes.mjs --tag v1.2.0                  # to stdout, linted (Docker)
//   node tools/release/notes.mjs --tag v1.2.0 --no-lint        # without Docker
//   node tools/release/notes.mjs --tag v1.2.0 --print-previous # the release before it
//   node --test tools/release/notes.test.mjs                   # its tests (git, no Docker)
//
// CI (.github/workflows/ci.yml, job `release`) also passes the images'
// digests and GitHub's generated notes (--changes), and writes the result to
// a file for `gh release`. Nothing here prints the notes to the log.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  JOURNAL,
  MIGRATIONS,
  RULES,
  lintFiles,
} from '../migration-lint/lint.mjs';

export const ENV_EXAMPLE = 'env.example';
export const CLIENT_PACKAGE = 'packages/api-client/package.json';
/** The files a rollback may need at the previous release too (docs/deployment.md). */
export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.prod.yaml',
  'compose.monitoring.yaml',
];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** A file's text at a commit, or null when the commit doesn't have it. */
function show(cwd, ref, file) {
  const result = spawnSync('git', ['show', `${ref}:${file}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

/** `v1.2.0-rc.1` is a pre-release; `v1.2.0` isn't. */
export function isPrerelease(tag) {
  return /^v\d+\.\d+\.\d+-/.test(tag);
}

/**
 * The release before `tag`: the nearest `v*` tag among its ancestors. A
 * final release skips pre-releases (v1.2.0 follows v1.1.0, not v1.2.0-rc.2);
 * a pre-release takes the nearest of either. null for the first release.
 */
export function previousTag(tag, { cwd = process.cwd() } = {}) {
  const [, ...parents] = git(cwd, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    `${tag}^{commit}`,
  ])
    .trim()
    .split(' ');
  if (!parents.length) return null; // the first commit
  const args = ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'];
  if (!isPrerelease(tag)) args.push('--exclude', 'v*-*');
  const result = spawnSync('git', [...args, `${tag}^`], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  // No ancestor has such a tag: the first release.
  if (/No (names found|tags can describe)/i.test(result.stderr)) return null;
  throw new Error(`git describe failed: ${result.stderr.trim()}`);
}

const isMigration = (p) =>
  path.posix.dirname(p) === MIGRATIONS && p.endsWith('.sql');

/**
 * The migrations `tag` adds since `previous` (all of them for the first
 * release), and what it changes in the ones `previous` had: edited or
 * deleted files, changed or removed journal entries. Those never happen
 * under the policy (the migration lint fails a pull request on them), so the
 * notes call them out.
 */
export function migrationChanges(previous, tag, { cwd = process.cwd() } = {}) {
  const added = [];
  const history = [];
  if (!previous) {
    const files = git(cwd, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      tag,
      '--',
      `${MIGRATIONS}/`,
    ]).split('\0');
    return { added: files.filter(isMigration).sort(), history };
  }
  const diff = git(cwd, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    previous,
    tag,
    '--',
    `${MIGRATIONS}/`,
  ]).split('\0');
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const [status, file] = [diff[i], diff[i + 1]];
    if (!isMigration(file)) continue;
    if (status === 'A') added.push(file);
    else
      history.push({
        file,
        message:
          status === 'D'
            ? 'deleted (or renamed) since the previous release'
            : 'edited since the previous release',
      });
  }
  const entries = (ref) => {
    const text = show(cwd, ref, JOURNAL);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed?.entries) ? parsed.entries : null;
    } catch {
      return null;
    }
  };
  const before = entries(previous);
  const after = entries(tag);
  if (before && !after) {
    history.push({
      file: JOURNAL,
      message: 'missing or unreadable at this release',
    });
  } else if (before && after) {
    before.forEach((entry, i) => {
      if (JSON.stringify(entry) !== JSON.stringify(after[i]))
        history.push({
          file: JOURNAL,
          message: `entry ${i} (${String(entry?.tag)}) ${after[i] === undefined ? 'removed' : 'changed'}`,
        });
    });
  }
  return { added: added.sort(), history };
}

/** The expand/contract lint's findings for `files` as they are at `ref` (squawk, in Docker). */
export function lintAt(files, ref, { cwd = process.cwd() } = {}) {
  if (!files.length) return [];
  const dir = mkdtempSync(path.join(tmpdir(), 'release-notes-'));
  try {
    for (const file of files) {
      const text = show(cwd, ref, file);
      if (text === null) throw new Error(`${file} is not in ${ref}`);
      mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    return lintFiles(files, { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The variable names env.example sets or shows commented out (`NAME=` or `# NAME=`). */
export function envVariables(text) {
  if (text === null) return new Set();
  return new Set(
    [...text.matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );
}

export function envChanges(previous, tag, { cwd = process.cwd() } = {}) {
  if (!previous) return { added: [], removed: [] };
  const before = envVariables(show(cwd, previous, ENV_EXAMPLE));
  const after = envVariables(show(cwd, tag, ENV_EXAMPLE));
  return {
    added: [...after].filter((v) => !before.has(v)).sort(),
    removed: [...before].filter((v) => !after.has(v)).sort(),
  };
}

/** The Compose files that differ between the two releases. */
export function composeChanges(previous, tag, { cwd = process.cwd() } = {}) {
  if (!previous) return [];
  return git(cwd, [
    'diff',
    '--name-only',
    '-z',
    previous,
    tag,
    '--',
    ...COMPOSE_FILES,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
}

/** The typed client's version at each release (null where it has none). */
export function clientVersions(previous, tag, { cwd = process.cwd() } = {}) {
  const version = (ref) => {
    const text = ref ? show(cwd, ref, CLIENT_PACKAGE) : null;
    try {
      return text === null ? null : (JSON.parse(text).version ?? null);
    } catch {
      return null;
    }
  };
  return {
    name: '@nestjs-monorepo-template/api-client',
    before: version(previous),
    after: version(tag),
  };
}

const BREAKING_SUBJECT = /^[a-z]+(\([^)]*\))?!:/;
const BREAKING_BODY = /^BREAKING[ -]CHANGE:/m;

/** The subjects of the commits since `previous` that announce a breaking change. */
export function breakingChanges(previous, tag, { cwd = process.cwd() } = {}) {
  if (!previous) return [];
  return git(cwd, [
    'log',
    '--first-parent',
    '--format=%s%x1f%b%x1e',
    `${previous}..${tag}`,
  ])
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [subject, body = ''] = record.split('\x1f');
      return {
        subject,
        breaking: BREAKING_SUBJECT.test(subject) || BREAKING_BODY.test(body),
      };
    })
    .filter((c) => c.breaking)
    .map((c) => c.subject);
}

/** Commit subjects come from main (merged pull requests): HTML is escaped, markdown and `(#12)` links stay. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const fileUrl = (repository, ref, file) =>
  `https://github.com/${repository}/blob/${encodeURIComponent(ref)}/${file.split('/').map(encodeURIComponent).join('/')}`;

/**
 * The notes' markdown. `findings` is null when the migrations weren't linted.
 */
export function render({
  repository,
  tag,
  previous,
  version,
  commit,
  digests = {},
  breaking = [],
  migrations,
  findings,
  env = { added: [], removed: [] },
  compose = [],
  client,
  changes = '',
}) {
  const image = `ghcr.io/${repository.toLowerCase()}`;
  const doc = (file, anchor = '') =>
    `[${file.replace(/^docs\//, '').replace(/\.md$/, '')}](${fileUrl(repository, tag, file)}${anchor})`;
  const out = [];

  if (breaking.length) {
    out.push('## Breaking changes', '');
    for (const subject of breaking) out.push(`- ${escapeHtml(subject)}`);
    out.push('');
  }

  out.push(
    '## Upgrading',
    '',
    `A project built on the template merges this tag: \`git fetch template --tags && git merge ${tag}\` (${doc('docs/upgrading.md')}). Read the sections below first: the migrations, the variables and the breaking changes are what an update needs beyond the merge.`,
    '',
  );

  out.push(
    '## Images',
    '',
    'Published by CI from this tag, after every check passed:',
    '',
    '| Image | Tag | Digest |',
    '| --- | --- | --- |',
  );
  for (const [name, ref, digest] of [
    ['App (api, worker, migrate)', `${image}:${version}`, digests.app],
    [
      'Gotenberg (PDF documents)',
      `${image}/gotenberg:${version}`,
      digests.gotenberg,
    ],
  ])
    out.push(
      `| ${name} | \`${ref}\` | ${digest ? `\`${digest}\`` : 'see the package page'} |`,
    );
  out.push(
    '',
    `Both are also tagged with the commit, \`${commit}\`. Deploying them: \`APP_IMAGE\` and \`GOTENBERG_IMAGE\` in \`.env\` (${doc('docs/deployment.md', '#publishing-and-rolling-back-images')}).`,
    '',
  );

  out.push('## Migrations', '');
  if (!previous) {
    out.push(
      `The first release: ${migrations.added.length} migrations under \`${MIGRATIONS}/\`. A new database applies them all.`,
      '',
    );
  } else if (!migrations.added.length && !migrations.history.length) {
    out.push(`None since ${previous}.`, '');
  } else {
    if (migrations.added.length) {
      out.push(
        `New since ${previous}, applied by \`node dist/migrate\` (the \`migrate\` service) before the new code starts:`,
        '',
      );
      for (const file of migrations.added)
        out.push(
          `- [\`${path.posix.basename(file)}\`](${fileUrl(repository, tag, file)})`,
        );
      out.push('');
    }
    if (migrations.history.length) {
      out.push(
        `**Changed since ${previous}, which drizzle never re-applies:** databases that ran the old version keep it.`,
        '',
      );
      for (const h of migrations.history)
        out.push(`- \`${h.file}\`: ${h.message}`);
      out.push('');
    }
    if (findings === null) {
      out.push('Not linted for destructive statements (`--no-lint`).', '');
    } else if (!findings.length) {
      if (migrations.added.length)
        out.push(
          `No destructive statements (the expand/contract lint): ${previous} runs on this schema.`,
          '',
        );
    } else {
      out.push(
        `**Destructive statements: ${findings.length}.** Each breaks a release that still uses what it drops or changes. A contract step is safe once the release before it stopped using that (${doc('docs/pitfalls.md', '#migrations-expandcontract')}).`,
        '',
        '| Where | Rule | Why |',
        '| --- | --- | --- |',
      );
      for (const f of findings)
        out.push(
          `| \`${path.posix.basename(f.file)}:${f.line}\` | \`${f.rule}\` | ${RULES[f.rule] ?? ''} |`,
        );
      out.push('');
    }
  }

  out.push('## Rolling back', '');
  if (!previous) {
    out.push('No earlier release to roll back to.', '');
  } else {
    const prevVersion = previous.replace(/^v/, '');
    out.push(
      `Rolling back is rolling the image back: set \`APP_IMAGE=${image}:${prevVersion}\` and \`GOTENBERG_IMAGE=${image}/gotenberg:${prevVersion}\` in \`.env\`, then \`docker compose pull migrate api worker gotenberg && docker compose up -d --remove-orphans\`.`,
      '',
      `Migrations don't roll back: ${previous} then runs on this release's schema. That works only under the expand/contract policy (${doc('docs/pitfalls.md', '#migrations-expandcontract')}): a release's migrations leave the release before it working.`,
      '',
    );
    if (migrations.history.length || (findings && findings.length)) {
      out.push(
        `**This release breaks that rule (above): ${previous} may fail on its schema.** Before rolling back past it, check every statement listed; where ${previous} still uses what one drops, restore the backup taken before the deploy instead (${doc('docs/deployment.md', '#backups-and-restore')}).`,
        '',
      );
    } else if (!migrations.added.length) {
      out.push(
        `This release adds no migrations: ${previous} runs on the schema it had.`,
        '',
      );
    }
    if (compose.length) {
      out.push(
        `The Compose files changed since ${previous} (${compose.map((f) => `\`${f}\``).join(', ')}): roll them back with the images, \`git checkout ${previous} -- ${compose.join(' ')}\`.`,
        '',
      );
    }
  }

  if (env.added.length || env.removed.length) {
    out.push(
      '## Configuration',
      '',
      `\`${ENV_EXAMPLE}\` since ${previous}:`,
      '',
    );
    if (env.added.length)
      out.push(`- New: ${env.added.map((v) => `\`${v}\``).join(', ')}.`);
    if (env.removed.length)
      out.push(`- Gone: ${env.removed.map((v) => `\`${v}\``).join(', ')}.`);
    out.push(
      '',
      `Compare yours with it before deploying (${doc('docs/configuration.md')}).`,
      '',
    );
  }

  if (client && client.after && client.before !== client.after) {
    out.push(
      '## Typed client',
      '',
      `\`${client.name}\` ${client.before ? `${client.before} → ` : ''}${client.after}: [its changelog](${fileUrl(repository, tag, 'packages/api-client/CHANGELOG.md')}).`,
      '',
    );
  }

  if (changes.trim()) out.push(changes.trim(), '');
  return `${out.join('\n').trimEnd()}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      previous: { type: 'string' },
      repository: { type: 'string' },
      'image-version': { type: 'string' },
      'app-digest': { type: 'string' },
      'gotenberg-digest': { type: 'string' },
      changes: { type: 'string' },
      'no-lint': { type: 'boolean', default: false },
      out: { type: 'string' },
      'print-previous': { type: 'boolean', default: false },
    },
  });
  const repository = values.repository || process.env.GITHUB_REPOSITORY;
  const tagValid =
    values.tag && /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(values.tag);
  // CI asks for the previous release first, for GitHub's generated notes.
  if (tagValid && values['print-previous']) {
    process.stdout.write(`${previousTag(values.tag) ?? ''}\n`);
    return 0;
  }
  if (!tagValid || !repository) {
    console.error(
      'Usage: notes.mjs --tag vX.Y.Z [--print-previous] [--previous vX.Y.Z|none] [--repository owner/repo (default: GITHUB_REPOSITORY)] [--image-version X.Y.Z] [--app-digest sha256:…] [--gotenberg-digest sha256:…] [--changes <file>] [--no-lint] [--out <file>]',
    );
    return 2;
  }
  const tag = values.tag;
  const previous =
    values.previous === 'none' ? null : (values.previous ?? previousTag(tag));
  const migrations = migrationChanges(previous, tag);
  // The first release has no previous one to break: nothing to lint.
  const findings = values['no-lint']
    ? null
    : previous
      ? lintAt(migrations.added, tag)
      : [];
  const notes = render({
    repository,
    tag,
    previous,
    version: values['image-version'] || tag.replace(/^v/, ''),
    commit: git(process.cwd(), ['rev-parse', `${tag}^{commit}`]).trim(),
    digests: {
      app: values['app-digest'],
      gotenberg: values['gotenberg-digest'],
    },
    breaking: breakingChanges(previous, tag),
    migrations,
    findings,
    env: envChanges(previous, tag),
    compose: composeChanges(previous, tag),
    client: clientVersions(previous, tag),
    changes: values.changes ? readFileSync(values.changes, 'utf8') : '',
  });
  if (values.out) writeFileSync(values.out, notes);
  else process.stdout.write(notes);
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
