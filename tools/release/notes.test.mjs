// The release notes' tests (node --test tools/release/notes.test.mjs): a
// throwaway repository with releases, read the way CI reads the real one.
// git only: the migration lint (Docker) has its own tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  breakingChanges,
  clientVersions,
  composeChanges,
  envChanges,
  envVariables,
  isPrerelease,
  migrationChanges,
  previousTag,
  render,
} from './notes.mjs';

let cwd;
const git = (...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
const write = (file, text) => {
  mkdirSync(path.join(cwd, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(cwd, file), text);
};
const journal = (...tags) =>
  JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: tags.map((tag, idx) => ({
      idx,
      version: '7',
      when: 1000 + idx,
      tag,
      breakpoints: true,
    })),
  });
const commit = (message) => {
  git('add', '-A');
  git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', message);
};
const client = (version) =>
  JSON.stringify({ name: '@nestjs-monorepo-template/api-client', version });

before(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'release-notes-test-'));
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');

  // v0.1.0: two migrations, a variable, the client at 0.0.1.
  write(
    'apps/api/drizzle/0000_init.sql',
    'CREATE TABLE "a" ("id" uuid PRIMARY KEY);\n',
  );
  write(
    'apps/api/drizzle/0001_b.sql',
    'CREATE TABLE "b" ("id" uuid PRIMARY KEY);\n',
  );
  write('apps/api/drizzle/meta/_journal.json', journal('0000_init', '0001_b'));
  write(
    'env.example',
    '# A comment: NOT_A_VARIABLE here\nAPP_DOMAIN=api.example.com\n# OLD_FLAG=on\nKEPT=1\n',
  );
  write('compose.yaml', 'services: {}\n');
  write('packages/api-client/package.json', client('0.0.1'));
  commit('feat: the first release');
  git('tag', 'v0.1.0');

  // v0.2.0-rc.1, then v0.2.0: a migration, a breaking change, variables, Compose, the client.
  write(
    'apps/api/drizzle/0002_c.sql',
    'ALTER TABLE "a" ADD COLUMN "c" text;\n',
  );
  write(
    'apps/api/drizzle/meta/_journal.json',
    journal('0000_init', '0001_b', '0002_c'),
  );
  commit('feat(notes)!: a breaking subject (#12)');
  git('tag', 'v0.2.0-rc.1');
  write(
    'env.example',
    '# A comment: NOT_A_VARIABLE here\nAPP_DOMAIN=api.example.com\nKEPT=1\nNEW_ONE=\n# NEW_OPTIONAL=x\n',
  );
  write('compose.yaml', 'services: { api: {} }\n');
  write('packages/api-client/package.json', client('0.1.0'));
  commit('fix: a fix\n\nBREAKING CHANGE: in the body');
  commit('chore: <b>not html</b>');
  git('tag', 'v0.2.0');

  // v0.3.0: an edited merged migration, nothing else.
  write(
    'apps/api/drizzle/0001_b.sql',
    'CREATE TABLE "b" ("id" uuid PRIMARY KEY, "x" int);\n',
  );
  commit('fix: edit a merged migration');
  git('tag', 'v0.3.0');
});

after(() => rmSync(cwd, { recursive: true, force: true }));

describe('previousTag', () => {
  it('is null for the first release', () => {
    assert.equal(previousTag('v0.1.0', { cwd }), null);
  });
  it('skips pre-releases for a final release', () => {
    assert.equal(previousTag('v0.2.0', { cwd }), 'v0.1.0');
  });
  it('takes the nearest release for a pre-release', () => {
    assert.equal(previousTag('v0.2.0-rc.1', { cwd }), 'v0.1.0');
  });
  it('takes the nearest final release', () => {
    assert.equal(previousTag('v0.3.0', { cwd }), 'v0.2.0');
  });
  it('fails on a tag that does not exist', () => {
    assert.throws(() => previousTag('v9.9.9', { cwd }));
  });
});

it('isPrerelease', () => {
  assert.equal(isPrerelease('v1.2.0-rc.1'), true);
  assert.equal(isPrerelease('v1.2.0'), false);
});

describe('migrationChanges', () => {
  it('lists every migration for the first release', () => {
    assert.deepEqual(migrationChanges(null, 'v0.1.0', { cwd }), {
      added: ['apps/api/drizzle/0000_init.sql', 'apps/api/drizzle/0001_b.sql'],
      history: [],
    });
  });
  it('lists the migrations added since the previous release', () => {
    assert.deepEqual(migrationChanges('v0.1.0', 'v0.2.0', { cwd }), {
      added: ['apps/api/drizzle/0002_c.sql'],
      history: [],
    });
  });
  it('reports an edited merged migration', () => {
    const { added, history } = migrationChanges('v0.2.0', 'v0.3.0', { cwd });
    assert.deepEqual(added, []);
    assert.deepEqual(history, [
      {
        file: 'apps/api/drizzle/0001_b.sql',
        message: 'edited since the previous release',
      },
    ]);
  });
});

it('envVariables reads set and commented-out variables, not prose', () => {
  assert.deepEqual(
    [
      ...envVariables(
        '# A comment: NOT_A_VARIABLE here\nA=1\n# B=\n#C=x\nlower=1\n',
      ),
    ],
    ['A', 'B', 'C'],
  );
  assert.deepEqual([...envVariables(null)], []);
});

it('envChanges', () => {
  assert.deepEqual(envChanges('v0.1.0', 'v0.2.0', { cwd }), {
    added: ['NEW_ONE', 'NEW_OPTIONAL'],
    removed: ['OLD_FLAG'],
  });
  assert.deepEqual(envChanges(null, 'v0.1.0', { cwd }), {
    added: [],
    removed: [],
  });
});

it('composeChanges', () => {
  assert.deepEqual(composeChanges('v0.1.0', 'v0.2.0', { cwd }), [
    'compose.yaml',
  ]);
  assert.deepEqual(composeChanges('v0.2.0', 'v0.3.0', { cwd }), []);
});

it('clientVersions', () => {
  assert.deepEqual(clientVersions('v0.1.0', 'v0.2.0', { cwd }), {
    name: '@nestjs-monorepo-template/api-client',
    before: '0.0.1',
    after: '0.1.0',
  });
});

it('breakingChanges reads `!` subjects and BREAKING CHANGE bodies', () => {
  assert.deepEqual(breakingChanges('v0.1.0', 'v0.2.0', { cwd }), [
    'fix: a fix',
    'feat(notes)!: a breaking subject (#12)',
  ]);
  assert.deepEqual(breakingChanges(null, 'v0.1.0', { cwd }), []);
});

describe('render', () => {
  const base = {
    repository: 'Owner/Repo',
    tag: 'v0.2.0',
    previous: 'v0.1.0',
    version: '0.2.0',
    commit: 'abc123',
    migrations: { added: ['apps/api/drizzle/0002_c.sql'], history: [] },
    findings: [],
  };

  it('names the images in lower case, by version and digest', () => {
    const notes = render({ ...base, digests: { app: 'sha256:aaa' } });
    assert.match(notes, /`ghcr\.io\/owner\/repo:0\.2\.0` \| `sha256:aaa` \|/);
    assert.match(
      notes,
      /`ghcr\.io\/owner\/repo\/gotenberg:0\.2\.0` \| see the package page \|/,
    );
    assert.match(
      notes,
      /`ghcr\.io\/owner\/repo\/caddy:0\.2\.0` \| see the package page \|/,
    );
    assert.match(notes, /tagged with the commit, `abc123`/);
  });

  it('gives the Caddy digest, and rolls CADDY_IMAGE back with the others', () => {
    const notes = render({
      ...base,
      digests: { app: 'sha256:aaa', caddy: 'sha256:ccc' },
    });
    assert.match(
      notes,
      /`ghcr\.io\/owner\/repo\/caddy:0\.2\.0` \| `sha256:ccc` \|/,
    );
    assert.match(notes, /CADDY_IMAGE=ghcr\.io\/owner\/repo\/caddy:0\.1\.0/);
    assert.match(
      notes,
      /docker compose pull migrate api worker gotenberg caddy/,
    );
  });

  it('lists the new migrations, linked at the tag, and says the previous release runs on them', () => {
    const notes = render(base);
    assert.match(
      notes,
      /\[`0002_c\.sql`\]\(https:\/\/github\.com\/Owner\/Repo\/blob\/v0\.2\.0\/apps\/api\/drizzle\/0002_c\.sql\)/,
    );
    assert.match(
      notes,
      /No destructive statements \(the expand\/contract lint\): v0\.1\.0 runs on this schema\./,
    );
    assert.match(notes, /APP_IMAGE=ghcr\.io\/owner\/repo:0\.1\.0/);
    assert.match(notes, /only under the expand\/contract policy/);
    assert.doesNotMatch(notes, /breaks that rule/);
  });

  it('warns the rollback when the lint finds a destructive statement', () => {
    const notes = render({
      ...base,
      findings: [
        {
          file: 'apps/api/drizzle/0002_c.sql',
          line: 1,
          rule: 'ban-drop-column',
          statement: 'x',
        },
      ],
    });
    assert.match(notes, /\*\*Destructive statements: 1\.\*\*/);
    assert.match(
      notes,
      /\| `0002_c\.sql:1` \| `ban-drop-column` \| Drops a column/,
    );
    assert.match(
      notes,
      /This release breaks that rule \(above\): v0\.1\.0 may fail on its schema\./,
    );
  });

  it('warns the rollback when a merged migration changed', () => {
    const notes = render({
      ...base,
      migrations: {
        added: [],
        history: [
          {
            file: 'apps/api/drizzle/0001_b.sql',
            message: 'edited since the previous release',
          },
        ],
      },
    });
    assert.match(notes, /which drizzle never re-applies/);
    assert.match(notes, /breaks that rule/);
  });

  it('says when the migrations were not linted', () => {
    assert.match(
      render({ ...base, findings: null }),
      /Not linted for destructive statements/,
    );
  });

  it('has no rollback for the first release', () => {
    const notes = render({
      ...base,
      tag: 'v0.1.0',
      previous: null,
      migrations: { added: ['a.sql', 'b.sql'], history: [] },
    });
    assert.match(notes, /The first release: 2 migrations/);
    assert.match(notes, /No earlier release to roll back to\./);
  });

  it('adds breaking changes (HTML escaped), variables, Compose, the client and the generated list', () => {
    const notes = render({
      ...base,
      breaking: ['feat!: <script> (#12)'],
      env: { added: ['NEW_ONE'], removed: ['OLD_FLAG'] },
      compose: ['compose.yaml'],
      client: {
        name: '@nestjs-monorepo-template/api-client',
        before: '0.0.1',
        after: '0.1.0',
      },
      changes: "## What's Changed\n* a pull request",
    });
    assert.ok(
      notes.startsWith(
        '## Breaking changes\n\n- feat!: &lt;script&gt; (#12)\n',
      ),
    );
    assert.match(notes, /- New: `NEW_ONE`\./);
    assert.match(notes, /- Gone: `OLD_FLAG`\./);
    assert.match(notes, /git checkout v0\.1\.0 -- compose\.yaml/);
    assert.match(
      notes,
      /`@nestjs-monorepo-template\/api-client` 0\.0\.1 → 0\.1\.0/,
    );
    assert.ok(notes.endsWith("## What's Changed\n* a pull request\n"));
  });

  it('leaves out the client when its version did not change', () => {
    const notes = render({
      ...base,
      client: { name: 'c', before: '0.1.0', after: '0.1.0' },
    });
    assert.doesNotMatch(notes, /## Typed client/);
  });
});
