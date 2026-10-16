// The lint's tests: node --test tools/migration-lint/lint.test.mjs (Docker
// runs squawk). The fixtures say on their first line what they must report
// (`-- expect: rule@line ...` or `-- expect: nothing`).
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  changes,
  code,
  escapeData,
  escapeProperty,
  JOURNAL,
  LABEL,
  labelDecision,
  lintFiles,
  MIGRATIONS,
  parseTrees,
  readLabel,
  report,
  RULES,
  text,
} from './lint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'lint.mjs');
const fixtures = path.join(here, 'fixtures');

function expected(file) {
  const first = readFileSync(file, 'utf8').split('\n')[0];
  const m = /^-- expect: (.*)$/.exec(first);
  assert.ok(m, `${file}: the first line must be "-- expect: ..."`);
  return m[1].trim() === 'nothing' ? [] : m[1].trim().split(/\s+/);
}

describe('the rules, on the fixtures', () => {
  const files = readdirSync(fixtures)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(fixtures, f));
  // One squawk run for all of them, as CI runs one for a pull request's files.
  const findings = lintFiles(files);

  for (const file of files) {
    test(path.basename(file), () => {
      const got = findings
        .filter((f) => f.file === file)
        .map((f) => `${f.rule}@${f.line}`);
      assert.deepEqual(got.sort(), expected(file).sort());
    });
  }

  test('every rule the lint reports has a fixture', () => {
    const covered = new Set(
      files.flatMap((f) => expected(f).map((e) => e.split('@')[0])),
    );
    assert.deepEqual(
      Object.keys(RULES).filter((r) => !covered.has(r)),
      [],
    );
  });

  test('a finding quotes its statement, without the breakpoint marker', () => {
    const drop = findings.find(
      (f) => f.file.endsWith('drop-column.sql') && f.line === 3,
    );
    assert.equal(
      drop.statement,
      'ALTER TABLE "api_clients" DROP COLUMN "key_id";',
    );
  });
});

describe("squawk's syntax tree", () => {
  test('one tree per file, checked against the files', () => {
    const output = [
      'SOURCE_FILE@0..9',
      '  DELETE@0..8',
      '    DELETE_KW@0..6 "DELETE"',
      '---',
      'ERROR@3 "x"',
      'SOURCE_FILE@0..4',
      '  TRUNCATE@0..4',
    ].join('\n');
    const trees = parseTrees(output, [9, 4]);
    assert.deepEqual(
      trees.map((t) => t.map((n) => n.kind)),
      [['DELETE', 'DELETE_KW'], ['TRUNCATE']],
    );
    assert.throws(() => parseTrees(output, [9]), /doesn't match the files/);
    assert.throws(() => parseTrees(output, [9, 5]), /doesn't match the files/);
  });
});

// A repository with merged migrations (the base), then the branch's changes.
function repository() {
  const dir = mkdtempSync(path.join(tmpdir(), 'migration-lint-test-'));
  const run = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  mkdirSync(path.join(dir, MIGRATIONS, 'meta'), { recursive: true });
  const journal = (entries) =>
    writeFileSync(
      path.join(dir, JOURNAL),
      `${JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2)}\n`,
    );
  const entry = (idx, tag, when) => ({
    idx,
    version: '7',
    when,
    tag,
    breakpoints: true,
  });
  const sql = (name, text) =>
    writeFileSync(path.join(dir, MIGRATIONS, `${name}.sql`), text);
  sql(
    '0000_init',
    'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "body" text);\n',
  );
  sql('0001_title', 'ALTER TABLE "notes" ADD COLUMN "title" text;\n');
  const merged = [entry(0, '0000_init', 1000), entry(1, '0001_title', 2000)];
  journal(merged);
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const base = run('rev-parse', 'HEAD');
  return { dir, base, run, journal, entry, sql, merged };
}

describe('the history check', () => {
  const repos = [];
  const repo = () => {
    const r = repository();
    repos.push(r.dir);
    return r;
  };
  after(() =>
    repos.forEach((d) => rmSync(d, { recursive: true, force: true })),
  );

  test('a new migration appended to the journal: nothing to report', () => {
    const r = repo();
    r.sql('0002_status', 'ALTER TABLE "notes" ADD COLUMN "status" text;\n');
    r.journal([...r.merged, r.entry(2, '0002_status', 3000)]);
    // Untracked, as right after `pnpm db:generate`...
    assert.deepEqual(changes({ base: r.base, cwd: r.dir }), {
      added: [`${MIGRATIONS}/0002_status.sql`],
      history: [],
    });
    // ...and committed.
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'status');
    assert.deepEqual(changes({ base: r.base, cwd: r.dir }), {
      added: [`${MIGRATIONS}/0002_status.sql`],
      history: [],
    });
  });

  test('an edited merged migration', () => {
    const r = repo();
    r.sql(
      '0001_title',
      'ALTER TABLE "notes" ADD COLUMN "title" text NOT NULL;\n',
    );
    const { history } = changes({ base: r.base, cwd: r.dir });
    assert.deepEqual(
      history.map((h) => h.file),
      [`${MIGRATIONS}/0001_title.sql`],
    );
    assert.match(history[0].message, /is edited/);
  });

  test('a deleted or renamed merged migration', () => {
    const r = repo();
    r.run(
      'mv',
      `${MIGRATIONS}/0001_title.sql`,
      `${MIGRATIONS}/0001_heading.sql`,
    );
    const { added, history } = changes({ base: r.base, cwd: r.dir });
    assert.deepEqual(added, [`${MIGRATIONS}/0001_heading.sql`]);
    assert.deepEqual(
      history.map((h) => h.file),
      [`${MIGRATIONS}/0001_title.sql`],
    );
    assert.match(history[0].message, /is deleted/);
  });

  test('a changed or removed journal entry', () => {
    const r = repo();
    r.journal([{ ...r.merged[0], when: 1500 }]);
    const { history } = changes({ base: r.base, cwd: r.dir });
    assert.deepEqual(
      history.map((h) => h.message.match(/is (changed|removed)/)[1]),
      ['changed', 'removed'],
    );
  });

  test('a new journal entry not later than the last merged one (drizzle would skip it)', () => {
    const r = repo();
    r.sql('0002_status', 'ALTER TABLE "notes" ADD COLUMN "status" text;\n');
    r.sql('0003_rank', 'ALTER TABLE "notes" ADD COLUMN "rank" integer;\n');
    r.journal([
      ...r.merged,
      r.entry(2, '0002_status', 1999),
      r.entry(3, '0003_rank', 4000),
    ]);
    const { history } = changes({ base: r.base, cwd: r.dir });
    assert.equal(history.length, 1);
    assert.match(history[0].message, /0002_status is not later/);
  });

  test("a branch behind its base: only its own changes, its new entries after the base's", () => {
    const r = repo();
    r.run('checkout', '-q', '-b', 'work');
    r.run('checkout', '-q', 'main');
    r.sql('0002_status', 'ALTER TABLE "notes" ADD COLUMN "status" text;\n');
    r.journal([...r.merged, r.entry(2, '0002_status', 3000)]);
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'status on main');
    const main = r.run('rev-parse', 'HEAD');
    r.run('checkout', '-q', 'work');
    r.sql('0002_rank', 'ALTER TABLE "notes" ADD COLUMN "rank" integer;\n');
    r.journal([...r.merged, r.entry(2, '0002_rank', 4000)]);
    // main's 0002_status isn't reported as deleted, nor its entry as removed.
    assert.deepEqual(changes({ base: main, cwd: r.dir }), {
      added: [`${MIGRATIONS}/0002_rank.sql`],
      history: [],
    });
    // Generated before main's: drizzle would skip it once both are merged.
    r.journal([...r.merged, r.entry(2, '0002_rank', 2500)]);
    const { history } = changes({ base: main, cwd: r.dir });
    assert.equal(history.length, 1);
    assert.match(history[0].message, /0002_rank is not later than the base/);
  });

  test('a deleted or broken journal', () => {
    const r = repo();
    writeFileSync(path.join(r.dir, JOURNAL), '{ not json');
    assert.match(
      changes({ base: r.base, cwd: r.dir }).history[0].message,
      /not a drizzle journal/,
    );
    unlinkSync(path.join(r.dir, JOURNAL));
    assert.match(
      changes({ base: r.base, cwd: r.dir }).history[0].message,
      /journal is deleted/,
    );
  });

  test('snapshots and files outside the migrations are not its business', () => {
    const r = repo();
    writeFileSync(
      path.join(r.dir, MIGRATIONS, 'meta', '0001_snapshot.json'),
      '{}\n',
    );
    mkdirSync(path.join(r.dir, 'docs'));
    writeFileSync(path.join(r.dir, 'docs', 'x.sql'), 'SELECT 1;\n');
    assert.deepEqual(changes({ base: r.base, cwd: r.dir }), {
      added: [],
      history: [],
    });
  });
});

describe('the report', () => {
  const finding = {
    file: `${MIGRATIONS}/0002_x.sql`,
    line: 3,
    rule: 'ban-drop-column',
    statement: 'ALTER TABLE "t" DROP COLUMN "c";',
  };
  const history = [
    {
      file: `${MIGRATIONS}/0001_title.sql`,
      message: 'A merged migration is edited.',
    },
  ];
  const added = [finding.file];

  test('report-only: destructive statements warn and pass', () => {
    const r = report({
      added,
      findings: [finding],
      history: [],
      fail: false,
      ack: false,
    });
    assert.equal(r.exitCode, 0);
    assert.match(
      r.annotations[0],
      /^::warning file=apps\/api\/drizzle\/0002_x\.sql,line=3,title=Destructive migration%3A ban-drop-column::/,
    );
    assert.match(r.summary, /Destructive statements: 1\*\* \(report-only\)/);
  });

  test('blocking: they fail, unless the pull request has the label', () => {
    const blocking = report({
      added,
      findings: [finding],
      history: [],
      fail: true,
      ack: false,
    });
    assert.equal(blocking.exitCode, 1);
    assert.match(blocking.annotations[0], /^::error /);
    const accepted = report({
      added,
      findings: [finding],
      history: [],
      fail: true,
      ack: true,
    });
    assert.equal(accepted.exitCode, 0);
    assert.match(accepted.annotations[0], /^::warning /);
    assert.match(
      accepted.summary,
      new RegExp(`accepted by the \`${LABEL}\` label`),
    );
  });

  test('a changed merged migration fails even when report-only, unless the label accepts it', () => {
    const r = report({
      added: [],
      findings: [],
      history,
      fail: false,
      ack: false,
    });
    assert.equal(r.exitCode, 1);
    assert.match(
      r.annotations[0],
      /^::error file=apps\/api\/drizzle\/0001_title\.sql,title=Migration history::/,
    );
    assert.equal(
      report({ added: [], findings: [], history, fail: false, ack: true })
        .exitCode,
      0,
    );
  });

  test('a squawk-ignore comment fails even when report-only, unless the label accepts it', () => {
    const ignore = { ...finding, rule: 'suppression-comment' };
    const r = report({
      added,
      findings: [ignore, finding],
      history: [],
      fail: false,
      ack: false,
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.annotations[0], /^::error .*suppression-comment::/);
    assert.match(r.annotations[1], /^::warning .*ban-drop-column::/);
    assert.match(r.summary, /1 squawk-ignore comments always fail/);
    assert.equal(
      report({ added, findings: [ignore], history: [], fail: false, ack: true })
        .exitCode,
      0,
    );
  });

  test("why a label on the pull request doesn't count, even with nothing new", () => {
    const note = `The \`${LABEL}\` label doesn't count: it was added before the latest push.`;
    const r = report({
      added: [],
      findings: [],
      history: [],
      fail: true,
      ack: false,
      note,
    });
    assert.ok(r.summary.includes(`**${note}**`));
  });

  test('nothing new', () => {
    const r = report({
      added: [],
      findings: [],
      history: [],
      fail: true,
      ack: false,
    });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.annotations, []);
    assert.match(r.summary, /No new or changed migrations/);
    assert.match(
      report({ added, findings: [], history: [], fail: true, ack: false })
        .summary,
      /No destructive statements/,
    );
  });

  test("the pull request's text can't become a workflow command, markdown or HTML", () => {
    assert.equal(escapeData('50%\r\n::stop'), '50%25%0D%0A::stop');
    assert.equal(escapeProperty('a,b:c\n'), 'a%2Cb%3Ac%0A');
    const evil = {
      ...finding,
      file: `${MIGRATIONS}/x,line=1::\n::error::y.sql`,
      statement: '```\n</details><img src=x> | [a](http://b)',
    };
    const r = report({
      added: [evil.file],
      findings: [evil],
      history: [],
      fail: false,
      ack: false,
    });
    assert.equal(r.annotations.length, 1);
    assert.ok(!/[\r\n]/.test(r.annotations[0]));
    assert.match(
      r.annotations[0],
      /^::warning file=apps\/api\/drizzle\/x%2Cline=1%3A%3A%0A%3A%3Aerror%3A%3Ay\.sql,line=3,/,
    );
    assert.equal(
      code('<b>|`[x](y)'),
      '<code>&#60;b&#62;&#124;&#96;&#91;x&#93;&#40;y&#41;</code>',
    );
    // GFM's autolinks: URLs and www. are found in the source (no `:`, no
    // `.`), e-mail addresses in the decoded text (`@` and a zero-width space).
    for (const encoded of [
      code('http://a.example x@y.example www.z.example'),
      text('see http://a.example, x@y.example and www.z.example'),
    ]) {
      assert.ok(!/[:.@]/.test(encoded.replace(/&#\d+;/g, '')), encoded);
      assert.ok(encoded.includes('&#64;&#8203;'));
    }
    // The statement sits in a fence longer than its own backticks: literal
    // text there, and nowhere else.
    const fence = /\n````sql\n([^]*?)\n````\n/.exec(r.summary);
    assert.ok(fence);
    assert.match(fence[1], /<img/);
    assert.ok(!r.summary.replace(fence[0], '').includes('<img'));
  });
});

describe('the command', () => {
  test('rejects a MIGRATION_LINT_FAIL other than empty or on', () => {
    const r = spawnSync('node', [script, '--base', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, MIGRATION_LINT_FAIL: 'yes' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /MIGRATION_LINT_FAIL must be/);
  });

  test('against a base: the summary and annotations files, and blocking', () => {
    const r = repository();
    try {
      r.sql('0002_drop_body', 'ALTER TABLE "notes" DROP COLUMN "body";\n');
      r.journal([...r.merged, r.entry(2, '0002_drop_body', 3000)]);
      const summary = path.join(r.dir, 'summary.md');
      const annotations = path.join(r.dir, 'annotations.txt');
      const run = (fail) =>
        spawnSync(
          'node',
          [
            script,
            '--base',
            r.base,
            '--summary',
            summary,
            '--annotations',
            annotations,
          ],
          {
            cwd: r.dir,
            encoding: 'utf8',
            env: { ...process.env, MIGRATION_LINT_FAIL: fail },
          },
        );
      const reporting = run('');
      assert.equal(reporting.status, 0, reporting.stderr);
      assert.equal(reporting.stdout, '');
      assert.match(
        readFileSync(summary, 'utf8'),
        /0002&#95;drop&#95;body&#46;sql&#58;1<\/code> \| \[`ban-drop-column`\]/,
      );
      assert.match(
        readFileSync(annotations, 'utf8'),
        /^::warning file=apps\/api\/drizzle\/0002_drop_body\.sql,line=1,/,
      );
      assert.equal(run('on').status, 1);
      assert.match(readFileSync(annotations, 'utf8'), /^::error /);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});

const at = (minute) => `2026-10-16T10:${String(minute).padStart(2, '0')}:00Z`;
const labeled = (minute, event = 'labeled', name = LABEL) => ({
  event,
  label: { name },
  created_at: at(minute),
});
const run = (minute) => ({ created_at: at(minute) });

describe('the label', () => {
  test('added after the head was pushed: it counts', () => {
    assert.deepEqual(
      labelDecision({ events: [labeled(5)], runs: [run(3), run(1)] }),
      { ack: true, note: '' },
    );
  });

  test('added before the latest push: it does not, and the summary says so', () => {
    const d = labelDecision({ events: [labeled(5)], runs: [run(7), run(9)] });
    assert.equal(d.ack, false);
    assert.match(d.note, /added before the latest push/);
    // In the same second as the push: not after it.
    assert.equal(
      labelDecision({ events: [labeled(7)], runs: [run(7)] }).ack,
      false,
    );
  });

  test('removed again, another label, or none: nothing to accept', () => {
    for (const events of [
      [labeled(5), labeled(6, 'unlabeled')],
      [labeled(5, 'labeled', 'documentation')],
      [],
    ]) {
      assert.deepEqual(labelDecision({ events, runs: [run(1)] }), {
        ack: false,
        note: '',
      });
    }
    // Events out of order: the latest decides.
    assert.equal(
      labelDecision({
        events: [labeled(6, 'unlabeled'), labeled(8), labeled(5)],
        runs: [run(1)],
      }).ack,
      true,
    );
  });

  test('no run of the head commit: when it was pushed is unknown, so no', () => {
    const d = labelDecision({ events: [labeled(5)], runs: [] });
    assert.equal(d.ack, false);
    assert.match(d.note, /unknown/);
  });

  // GitHub's REST API, as the lint calls it: the token, two pages of events.
  async function fakeGitHub(events, runs) {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      const base = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/repos/o/r/issues/7/events?per_page=100') {
        res.setHeader(
          'link',
          `<${base}/repos/o/r/issues/7/events?per_page=100&page=2>; rel="next"`,
        );
        res.end(JSON.stringify(events.slice(0, 1)));
      } else if (req.url === '/repos/o/r/issues/7/events?per_page=100&page=2') {
        res.end(JSON.stringify(events.slice(1)));
      } else if (
        req.url ===
        '/repos/o/r/actions/runs?head_sha=abc123&event=pull_request&per_page=100'
      ) {
        res.end(
          JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
        );
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      api: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => server.close(),
    };
  }

  test("read from the API: every page of events, the head commit's runs", async () => {
    const gh = await fakeGitHub([labeled(2), labeled(5)], [run(3)]);
    try {
      const d = await readLabel({
        api: gh.api,
        repository: 'o/r',
        pr: '7',
        head: 'abc123',
        token: 't0k',
      });
      assert.deepEqual(d, { ack: true, note: '' });
      assert.equal(gh.requests.length, 3);
      assert.ok(gh.requests.every((r) => r.auth === 'Bearer t0k'));
    } finally {
      gh.close();
    }
  });

  test('the command: --pr and --head, the label accepting a blocking finding', async () => {
    const r = repository();
    const gh = await fakeGitHub([labeled(5)], [run(3)]);
    try {
      r.sql('0002_drop_body', 'ALTER TABLE "notes" DROP COLUMN "body";\n');
      r.journal([...r.merged, r.entry(2, '0002_drop_body', 3000)]);
      const summary = path.join(r.dir, 'summary.md');
      const lint = (env) =>
        promisify(execFile)(
          'node',
          [
            script,
            '--base',
            r.base,
            '--summary',
            summary,
            '--pr',
            '7',
            '--head',
            'abc123',
          ],
          {
            cwd: r.dir,
            env: {
              ...process.env,
              MIGRATION_LINT_FAIL: 'on',
              GITHUB_REPOSITORY: 'o/r',
              GITHUB_TOKEN: 't0k',
              ...env,
            },
          },
        );
      await lint({ GITHUB_API_URL: gh.api });
      assert.match(
        readFileSync(summary, 'utf8'),
        /accepted by the `destructive-migration` label/,
      );
      // The API unreachable: the label doesn't count, and the job fails.
      await assert.rejects(
        lint({ GITHUB_API_URL: 'http://127.0.0.1:9' }),
        (e) => e.code === 1,
      );
      assert.match(readFileSync(summary, 'utf8'), /label couldn't be read/);
    } finally {
      gh.close();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});
