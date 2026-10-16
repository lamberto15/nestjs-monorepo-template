#!/usr/bin/env node
// The expand/contract lint (docs/pitfalls.md, "Migrations: expand/contract"):
// flags the statements in new migrations that break the release before them
// (a rollback runs it on the newer schema; during a deploy, old and new
// replicas share it), and changes to migrations that were already merged.
//
// The SQL is read by squawk (github.com/sbdchd/squawk), PostgreSQL's
// migration linter, in a container without network: its rules for drops,
// renames, retypes, NOT NULL and defaults, and its syntax tree (`--debug
// parse`) for what it has no rule for (TRUNCATE, DELETE and UPDATE without
// WHERE, MERGE's DELETE and UPDATE). The tree is a debugging output, not an
// API: it is checked against the files' lengths, and lint.test.mjs covers
// every rule reported, so a new squawk release is tested before it is used.
// Its version is pinned here and raised by hand (Dependabot doesn't see it).
//
//   node tools/migration-lint/lint.mjs --base origin/main     # this branch's migrations (Docker)
//   node tools/migration-lint/lint.mjs apps/api/drizzle/*.sql # given files, no history check
//   node --test tools/migration-lint/lint.test.mjs            # its tests (Docker too)
//
// CI (.github/workflows/migrations.yml) also passes --summary, --annotations,
// and --pr with --head for the label (GITHUB_TOKEN reads it). The migrations
// come from the pull request: their text goes to the summary (encoded), never
// to the log, where a line starting with :: would run as a workflow command.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

/** squawk's release, tag and digest (linux/amd64 only: Docker emulates it on arm64). */
export const SQUAWK_IMAGE =
  'ghcr.io/sbdchd/squawk:2.70.0@sha256:95707f5660dfadbc61cf9d9565384b54d157dcb4e8d3c30db78dd7056be293e9';

export const MIGRATIONS = 'apps/api/drizzle';
export const JOURNAL = `${MIGRATIONS}/meta/_journal.json`;

/**
 * The pull request label that accepts what the lint reports (a reviewed
 * contract step, a deliberate reset of the history). It counts only when it
 * was added after the head commit was pushed: a later push needs it again.
 */
export const LABEL = 'destructive-migration';

const LATER = 'Stop using it in one release, then drop it in the next.';

/**
 * The rules reported, with what to do instead: squawk's own names (its
 * other rules, about locks and style, are left out), then this lint's.
 * Every rule here has a fixture in fixtures/.
 */
export const RULES = {
  'ban-drop-table': `Drops a table the previous release still uses. ${LATER}`,
  'ban-drop-column': `Drops a column the previous release still reads and writes. ${LATER}`,
  'ban-drop-type': `Drops a type the previous release's columns or queries may use. ${LATER}`,
  'ban-drop-index':
    'Drops an index the previous release may rely on (a unique one is a guarantee). Drop it a release after the code stops needing it.',
  'ban-drop-view': `Drops a view the previous release may query. ${LATER}`,
  'ban-drop-function': `Drops a function the previous release may call. ${LATER}`,
  'ban-drop-schema': `Drops a schema the previous release may use. ${LATER}`,
  'ban-drop-sequence': `Drops a sequence the previous release may use. ${LATER}`,
  'ban-drop-domain': `Drops a domain the previous release's columns may use. ${LATER}`,
  'ban-drop-extension': `Drops an extension the previous release may use. ${LATER}`,
  'ban-drop-database': 'Drops a database.',
  'ban-drop-constraint':
    'Drops a constraint (unique, foreign key, check) the previous release may rely on. Drop it a release after the code stops relying on it.',
  'ban-drop-default':
    'Drops a default the previous release relies on when it inserts without the column. Drop it once no running release omits the column.',
  'ban-drop-not-null':
    'Lets NULL into a column the previous release reads as never NULL. Expected in the release that stops writing a required column: check the previous release copes.',
  'ban-drop-generated-expression': `Turns a generated column into a plain one the previous release never writes. ${LATER}`,
  'ban-alter-identity':
    'Changes an identity column the previous release inserts into.',
  'ban-set-schema':
    'Moves an object out of the schema the previous release finds it in. Create the new one, move the code, drop the old one a release later.',
  'changing-column-type':
    'Retypes a column the previous release reads and writes (and rewrites the table under a lock). Add a column of the new type, write both, backfill, switch reads, drop the old one a release later.',
  'renaming-column':
    'The previous release still uses the old name. Add the new column, write both, backfill, switch reads, drop the old one a release later.',
  'renaming-table':
    'The previous release still uses the old name. Create the new table (or a view under the old name), move the code, drop the old one a release later.',
  'renaming-object':
    'The previous release still uses the old name (an index, a constraint, an enum value...). Rename a release after the code stops using it.',
  'adding-not-nullable-field':
    'SET NOT NULL fails the previous release where it inserts without the column. Set it a release after every release writes the column and the rows are backfilled.',
  'adding-required-field':
    'A NOT NULL column without a default fails the previous release, which inserts without it (and fails on a populated table). Add it with a default (or nullable), then tighten it a release later.',
  'syntax-error': 'squawk could not parse the statement: review it by hand.',
  'truncate-table':
    'Empties a table: the previous release (and a rollback) loses its rows.',
  'delete-without-where':
    'Deletes every row of a table: the previous release (and a rollback) loses them.',
  'update-without-where':
    'Rewrites every row of a table: the previous release (and a rollback) gets the new values.',
  'merge-delete':
    'MERGE deletes the rows it matches: the previous release (and a rollback) loses them.',
  'merge-update':
    'MERGE rewrites the rows it matches: the previous release (and a rollback) gets the new values.',
  'suppression-comment':
    'A squawk-ignore comment would hide statements from this lint (which blanks it before squawk reads the file). Migrations are generated, never edited: remove it. Fails like a changed merged migration.',
};

/** This lint's rules, the rest are squawk's. */
const OWN_RULES = [
  'truncate-table',
  'delete-without-where',
  'update-without-where',
  'merge-delete',
  'merge-update',
  'suppression-comment',
];
const SQUAWK_RULES = Object.keys(RULES).filter((r) => !OWN_RULES.includes(r));

/** Findings that fail whether blocking or not (as history changes do). */
export const ALWAYS_FAILING = ['suppression-comment'];

// ---------------------------------------------------------------------------
// The SQL: squawk's findings and its syntax tree.

/** Runs squawk in a container that sees only the given files, as m0.sql, m1.sql... */
function squawk(dir, names, args) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--platform',
      'linux/amd64',
      '-v',
      `${dir}:/data:ro`,
      '-w',
      '/data',
      SQUAWK_IMAGE,
      ...args,
      ...names,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  return result;
}

/**
 * The statements' nodes from squawk's syntax tree (one `KIND@start..end`
 * per line, two spaces of indent per level, offsets in bytes), one tree per
 * file. A tree whose length isn't its file's means the format changed.
 */
export function parseTrees(output, sizes) {
  const trees = [];
  for (const line of output.split('\n')) {
    const m = /^( *)([A-Z][A-Z0-9_]*)@(\d+)\.\.(\d+)/.exec(line);
    if (!m) continue;
    const node = {
      depth: m[1].length / 2,
      kind: m[2],
      start: Number(m[3]),
      end: Number(m[4]),
    };
    if (node.depth === 0) {
      if (node.kind !== 'SOURCE_FILE')
        throw new Error(`squawk's syntax tree: unexpected root ${node.kind}`);
      trees.push([]);
    } else if (trees.length) {
      trees[trees.length - 1].push(node);
    }
  }
  const roots = [...output.matchAll(/^SOURCE_FILE@0\.\.(\d+)/gm)].map((m) =>
    Number(m[1]),
  );
  if (roots.length !== sizes.length || roots.some((n, i) => n !== sizes[i])) {
    throw new Error(
      `squawk's syntax tree doesn't match the files (lengths ${roots.join(', ')}; expected ${sizes.join(', ')})`,
    );
  }
  return trees;
}

/**
 * Statements kept for later, not run by the migration: a rule's action, the
 * body of a function or procedure (BEGIN ATOMIC). Their DML isn't reported.
 */
const DEFERRED = ['CREATE_RULE', 'ATOMIC_BODY'];

/**
 * TRUNCATE anywhere; DELETE and UPDATE (CTEs too) without a WHERE clause of
 * their own; MERGE's WHEN ... THEN DELETE and THEN UPDATE.
 */
export function dmlFindings(nodes) {
  const found = [];
  const ancestors = [];
  nodes.forEach((node, i) => {
    while (ancestors.length && ancestors.at(-1).depth >= node.depth)
      ancestors.pop();
    const deferred = ancestors.some((a) => DEFERRED.includes(a.kind));
    ancestors.push(node);
    if (deferred) return;
    if (node.kind === 'TRUNCATE')
      found.push({ rule: 'truncate-table', offset: node.start });
    if (node.kind === 'MERGE_DELETE')
      found.push({ rule: 'merge-delete', offset: node.start });
    if (node.kind === 'MERGE_UPDATE')
      found.push({ rule: 'merge-update', offset: node.start });
    if (node.kind !== 'DELETE' && node.kind !== 'UPDATE') return;
    let where = false;
    for (let j = i + 1; j < nodes.length && nodes[j].depth > node.depth; j++) {
      if (nodes[j].depth === node.depth + 1 && nodes[j].kind === 'WHERE_CLAUSE')
        where = true;
    }
    if (!where)
      found.push({
        rule: `${node.kind.toLowerCase()}-without-where`,
        offset: node.start,
      });
  });
  return found;
}

/**
 * squawk obeys `-- squawk-ignore <rule>` and `-- squawk-ignore-file` in the
 * file, and no option turns that off. Each occurrence (any case, in comments
 * or not) is a finding, and is blanked with as many spaces in the copy squawk
 * reads, so it suppresses nothing and the offsets stay the same.
 */
const IGNORE = /squawk-ignore/gi;
export function ignoreComments(buffer) {
  const text = buffer.toString('latin1');
  const offsets = [...text.matchAll(IGNORE)].map((m) => m.index);
  const blanked = Buffer.from(
    text.replace(IGNORE, (m) => ' '.repeat(m.length)),
    'latin1',
  );
  return { offsets, blanked };
}

function lineAt(buffer, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < buffer.length; i++)
    if (buffer[i] === 0x0a) line++;
  return line;
}

function sourceLine(text, line) {
  const raw = text.split('\n')[line - 1] ?? '';
  const s = raw
    .replace(/--> statement-breakpoint\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * The destructive statements in the given migration files (paths relative
 * to cwd): [{ file, line, rule, statement }], sorted.
 */
export function lintFiles(files, { cwd = process.cwd() } = {}) {
  if (!files.length) return [];
  const dir = mkdtempSync(path.join(tmpdir(), 'migration-lint-'));
  try {
    // squawk runs as its own user: the copies must be readable by others.
    chmodSync(dir, 0o755);
    const buffers = files.map((f) => readFileSync(path.resolve(cwd, f)));
    const found = [];
    const names = buffers.map((b, i) => {
      const { offsets, blanked } = ignoreComments(b);
      for (const offset of offsets)
        found.push({
          file: files[i],
          line: lineAt(b, offset),
          rule: 'suppression-comment',
        });
      writeFileSync(path.join(dir, `m${i}.sql`), blanked, { mode: 0o644 });
      return `m${i}.sql`;
    });
    const fileOf = (name) => files[names.indexOf(name)];

    const checked = squawk(dir, names, [
      '--reporter',
      'json',
      '--pg-version',
      '18.0',
      '--include',
      'ban-drop-index',
    ]);
    // 0: nothing found, 1: findings; anything else is squawk failing.
    if (checked.status !== 0 && checked.status !== 1) {
      throw new Error(
        `squawk exited with ${checked.status}: ${checked.stderr.slice(0, 2000)}`,
      );
    }
    const violations = JSON.parse(checked.stdout);
    const tree = squawk(dir, names, ['--debug', 'parse']);
    if (tree.status !== 0)
      throw new Error(
        `squawk --debug parse exited with ${tree.status}: ${tree.stderr.slice(0, 2000)}`,
      );
    const trees = parseTrees(
      tree.stdout,
      buffers.map((b) => b.length),
    );

    for (const v of violations) {
      if (!SQUAWK_RULES.includes(v.rule_name)) continue;
      const file = fileOf(v.file);
      if (file === undefined)
        throw new Error(
          `squawk reported an unknown file ${JSON.stringify(v.file)}`,
        );
      found.push({ file, line: v.line + 1, rule: v.rule_name });
    }
    trees.forEach((nodes, i) => {
      for (const d of dmlFindings(nodes))
        found.push({
          file: files[i],
          line: lineAt(buffers[i], d.offset),
          rule: d.rule,
        });
    });

    const texts = buffers.map((b) => b.toString('utf8'));
    const seen = new Set();
    return found
      .filter((f) => {
        const key = `${f.file}\0${f.line}\0${f.rule}`;
        return seen.has(key) ? false : (seen.add(key), true);
      })
      .map((f) => ({
        ...f,
        statement: sourceLine(texts[files.indexOf(f.file)], f.line),
      }))
      .sort((a, b) =>
        a.file < b.file
          ? -1
          : a.file > b.file
            ? 1
            : a.line - b.line || (a.rule < b.rule ? -1 : 1),
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The history: what the branch changes in migrations that were merged.

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function readJournal(text, where, history) {
  try {
    const journal = JSON.parse(text);
    if (!Array.isArray(journal?.entries)) throw new Error('no entries');
    return journal.entries;
  } catch {
    history.push({
      file: JOURNAL,
      message: `The journal ${where} is not a drizzle journal (JSON with entries).`,
    });
    return null;
  }
}

function journalAt(cwd, commit, history) {
  if (git(cwd, ['ls-tree', '--name-only', commit, '--', JOURNAL]).trim() === '')
    return null;
  return readJournal(
    git(cwd, ['show', `${commit}:${JOURNAL}`]),
    'on the base branch',
    history,
  );
}

/**
 * Compared with `base` (the branch the work goes into): the migration files
 * the working tree adds (committed or not), and the changes to merged
 * migrations that drizzle can't apply: an edited, deleted or renamed
 * migration (databases that ran it keep the old one; new ones get the new),
 * a changed or removed journal entry, a new entry not later than the base's
 * last (drizzle's migrator skips a migration older than the last it applied).
 *
 * Files and entries are compared with the merge base, so a branch behind
 * `base` isn't charged with what `base` added since (in CI, the merge base
 * is the base itself); the order of new entries, with `base`'s last.
 */
export function changes({ base, cwd = process.cwd() }) {
  const added = [];
  const history = [];
  const isMigration = (p) =>
    path.posix.dirname(p) === MIGRATIONS && p.endsWith('.sql');
  const fork = git(cwd, ['merge-base', base, 'HEAD']).trim();

  const diff = git(cwd, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    fork,
    '--',
    `${MIGRATIONS}/`,
  ]).split('\0');
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const [status, file] = [diff[i], diff[i + 1]];
    if (!isMigration(file)) continue;
    if (status === 'A') added.push(file);
    else if (status === 'D')
      history.push({
        file,
        message:
          'A merged migration is deleted (or renamed). Databases that applied it keep it; new ones never get it.',
      });
    else
      history.push({
        file,
        message:
          'A merged migration is edited. Databases that applied it keep the old version; new ones get this one. Generate a new migration instead.',
      });
  }
  const untracked = git(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    `${MIGRATIONS}/`,
  ]).split('\0');
  added.push(...untracked.filter(isMigration));

  const headPath = path.join(cwd, JOURNAL);
  const before = journalAt(cwd, fork, history);
  if (before && !existsSync(headPath)) {
    history.push({
      file: JOURNAL,
      message:
        'The journal is deleted: drizzle applies no migration without it.',
    });
  } else if (before) {
    const after = readJournal(
      readFileSync(headPath, 'utf8'),
      'of this branch',
      history,
    );
    const target =
      fork === git(cwd, ['rev-parse', base]).trim()
        ? before
        : journalAt(cwd, base, history);
    if (after) {
      before.forEach((entry, i) => {
        if (!isDeepStrictEqual(entry, after[i])) {
          history.push({
            file: JOURNAL,
            message: `The journal's merged entry ${i} (${String(entry?.tag)}) is ${after[i] === undefined ? 'removed' : 'changed'}. Merged entries never change; new ones are appended.`,
          });
        }
      });
      let last = Math.max(
        ...[...before, ...(target ?? [])].map((e) => Number(e?.when) || 0),
        0,
      );
      for (const entry of after.slice(before.length)) {
        const when = Number(entry?.when);
        if (!(when > last)) {
          history.push({
            file: JOURNAL,
            message: `The new entry ${String(entry?.tag)} is not later than the base branch's last one: drizzle skips it on databases that applied that one. Delete the migration and generate it again on top of the base branch.`,
          });
        }
        last = Math.max(last, when || 0);
      }
    }
  }
  return { added: [...new Set(added)].sort(), history };
}

// ---------------------------------------------------------------------------
// The label: on the pull request now, and added after its head was pushed.

/**
 * Whether the label accepts this run's findings, from the pull request's
 * issue events (GET /repos/{repo}/issues/{n}/events) and the workflow runs
 * of its head commit (GET /repos/{repo}/actions/runs?head_sha=…&event=pull_request).
 * The earliest of those runs is when the head was pushed (GitHub's clock,
 * not the commit's dates, which the author sets); the label must have been
 * added after it, so it never approves a push made after the review.
 */
export function labelDecision({ events, runs, label = LABEL }) {
  const toggles = events
    .filter(
      (e) =>
        (e.event === 'labeled' || e.event === 'unlabeled') &&
        e.label?.name === label,
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const last = toggles.at(-1);
  if (!last || last.event !== 'labeled') return { ack: false, note: '' };
  const pushed = Math.min(...runs.map((r) => Date.parse(r.created_at)));
  if (!Number.isFinite(pushed))
    return {
      ack: false,
      note: `The \`${label}\` label doesn't count: when the head commit was pushed is unknown.`,
    };
  if (!(Date.parse(last.created_at) > pushed))
    return {
      ack: false,
      note: `The \`${label}\` label doesn't count: it was added before the latest push. Review the new commits, then remove it and add it again.`,
    };
  return { ack: true, note: '' };
}

/** Every page of a GitHub REST list (the Link header's next). */
async function listAll(url, token, pick = (body) => body) {
  const items = [];
  for (let next = url; next;) {
    const response = await fetch(next, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok)
      throw new Error(`GitHub API ${response.status} for ${next}`);
    items.push(...pick(await response.json()));
    next = /<([^>]+)>;\s*rel="next"/.exec(
      response.headers.get('link') ?? '',
    )?.[1];
  }
  return items;
}

export async function readLabel({ api, repository, pr, head, token }) {
  const [events, runs] = await Promise.all([
    listAll(
      `${api}/repos/${repository}/issues/${pr}/events?per_page=100`,
      token,
    ),
    listAll(
      `${api}/repos/${repository}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`,
      token,
      (body) => body.workflow_runs ?? [],
    ),
  ]);
  return labelDecision({ events, runs });
}

// ---------------------------------------------------------------------------
// The report.

/** GitHub's workflow command escaping (@actions/core): the message, then properties. */
export function escapeData(s) {
  return String(s)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}
export function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// GFM finds URL and www. autolinks in the source (so an encoded `:` or `.`
// stops them) and e-mail ones in the decoded text (so `@` gets a zero-width
// space after it).
const entity = (c) => (c === '@' ? '&#64;&#8203;' : `&#${c.codePointAt(0)};`);

/** Text from the pull request in the summary: every sign encoded, so it is never markdown, HTML or a link. */
export function code(s) {
  return `<code>${String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N} -]/gu, entity)}</code>`;
}

/** A sentence that may quote the pull request (a journal tag): markdown's, HTML's and links' signs encoded. */
export function text(s) {
  return String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>&*_`|#!~[\](){}\\/:.@]/g, entity);
}

/** A fence longer than any run of backticks in the text. */
function fenced(text) {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}sql\n${text}\n${fence}`;
}

const MAX_ROWS = 200;

/**
 * The job's summary, its annotations and its exit code. `fail`: blocking
 * (MIGRATION_LINT_FAIL=on); `ack`: the label accepts the findings (`note`
 * says why one on the pull request doesn't). Destructive statements fail
 * only when blocking; history changes and squawk-ignore comments always do.
 */
export function report({ added, findings, history, fail, ack, note = '' }) {
  const always = (f) => ALWAYS_FAILING.includes(f.rule);
  const blocking =
    history.length > 0 ||
    findings.some(always) ||
    (fail && findings.length > 0);
  const exitCode = blocking && !ack ? 1 : 0;
  const level = (failing) => (failing && !ack ? 'error' : 'warning');
  const annotations = [
    ...history.map(
      (h) =>
        `::${level(true)} file=${escapeProperty(h.file)},title=${escapeProperty('Migration history')}::${escapeData(h.message)}`,
    ),
    ...findings.map(
      (f) =>
        `::${level(fail || always(f))} file=${escapeProperty(f.file)},line=${f.line},title=${escapeProperty(`Destructive migration: ${f.rule}`)}::${escapeData(RULES[f.rule])}`,
    ),
  ];

  const out = ['## Migrations', ''];
  if (note) out.push(`**${note}**`, '');
  if (!added.length && !history.length) {
    out.push(`No new or changed migrations (\`${MIGRATIONS}/\`).`, '');
    return { summary: out.join('\n'), annotations, exitCode };
  }
  if (added.length)
    out.push(
      `New: ${added.map((f) => code(path.posix.basename(f))).join(', ')}.`,
      '',
    );
  const mode = fail ? 'blocking' : 'report-only';
  const accepted = ack ? `; accepted by the \`${LABEL}\` label` : '';

  if (history.length) {
    out.push(
      `**Merged migrations changed: ${history.length}** (always fails${accepted}).`,
      '',
    );
    for (const h of history) out.push(`- ${code(h.file)}: ${text(h.message)}`);
    out.push('');
  }
  if (!findings.length) {
    if (added.length) out.push('No destructive statements.', '');
  } else {
    const ignores = findings.filter(always).length;
    out.push(
      `**Destructive statements: ${findings.length}** (${mode}${ignores ? `; ${ignores} squawk-ignore comments always fail` : ''}${accepted}). Each breaks the release before this one, which a rollback runs on this schema and which runs beside this one during a deploy: make the change in two releases (docs/pitfalls.md, "Migrations: expand/contract"). A reviewed contract step takes the \`${LABEL}\` label, added after its last push.`,
      '',
      '| Where | Rule | Why, and the two-release way |',
      '| --- | --- | --- |',
    );
    for (const f of findings.slice(0, MAX_ROWS)) {
      const rule =
        SQUAWK_RULES.includes(f.rule) && f.rule !== 'syntax-error'
          ? `[\`${f.rule}\`](https://squawkhq.com/docs/${f.rule})`
          : `\`${f.rule}\``;
      out.push(
        `| ${code(`${path.posix.basename(f.file)}:${f.line}`)} | ${rule} | ${RULES[f.rule]} |`,
      );
    }
    if (findings.length > MAX_ROWS)
      out.push('', `And ${findings.length - MAX_ROWS} more.`);
    const statements = findings
      .slice(0, MAX_ROWS)
      .map((f) => `${path.posix.basename(f.file)}:${f.line}: ${f.statement}`);
    out.push(
      '',
      '<details><summary>The statements</summary>',
      '',
      fenced([...new Set(statements)].join('\n')),
      '',
      '</details>',
      '',
    );
  }
  return { summary: out.join('\n'), annotations, exitCode };
}

// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      base: { type: 'string' },
      summary: { type: 'string' },
      annotations: { type: 'string' },
      pr: { type: 'string' },
      head: { type: 'string' },
    },
    allowPositionals: true,
  });
  const failSetting = process.env.MIGRATION_LINT_FAIL ?? '';
  if (failSetting !== '' && failSetting !== 'on') {
    console.error(
      `MIGRATION_LINT_FAIL must be '' (report only) or 'on' (blocking), not ${JSON.stringify(failSetting)}.`,
    );
    return 2;
  }
  if (
    (!values.base && !positionals.length) ||
    Boolean(values.pr) !== Boolean(values.head)
  ) {
    console.error(
      'Usage: lint.mjs --base <commit> [--summary <file>] [--annotations <file>] [--pr <number> --head <sha>] | lint.mjs <file.sql>...',
    );
    return 2;
  }
  const { added, history } = positionals.length
    ? { added: positionals, history: [] }
    : changes({ base: values.base });
  const findings = lintFiles(added);
  let label = { ack: false, note: '' };
  if (values.pr) {
    try {
      label = await readLabel({
        api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
        repository: process.env.GITHUB_REPOSITORY,
        pr: values.pr,
        head: values.head,
        token: process.env.GITHUB_TOKEN,
      });
    } catch (error) {
      label = {
        ack: false,
        note: `The \`${LABEL}\` label couldn't be read (${error instanceof Error ? error.message : error}): it doesn't count.`,
      };
    }
  }
  const result = report({
    added,
    findings,
    history,
    fail: failSetting === 'on',
    ...label,
  });
  if (values.summary) appendFileSync(values.summary, `${result.summary}\n`);
  else process.stdout.write(`${result.summary}\n`);
  if (values.annotations)
    writeFileSync(
      values.annotations,
      result.annotations.map((a) => `${a}\n`).join(''),
    );
  return result.exitCode;
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
