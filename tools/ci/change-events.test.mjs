import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NIGHTLY_CRON, runChanges } from './changes.mjs';
import { releasePlan } from './release-manifest.mjs';
const base = 'a'.repeat(40),
  head = 'b'.repeat(40);

function eventOutput(
  eventName,
  event,
  response,
  {
    ref = 'refs/heads/main',
    planning = releasePlan,
    bumped = () => false,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-events-'));
  try {
    const eventPath = join(dir, 'event.json'),
      output = join(dir, 'outputs');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(output, '');
    const env = {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF: ref,
      GITHUB_SHA: head,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: dir,
    };
    const calls = [];
    const result = runChanges(
      env,
      (args) => {
        calls.push(args);
        if (response instanceof Error) throw response;
        return JSON.stringify(response);
      },
      planning,
      () => ['apps/api/example.ts'],
      bumped,
    );
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    assert.equal(
      lines.length,
      new Set(lines.map((line) => line.split('=')[0])).size,
      'outputs are written exactly once',
    );
    return { result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('PR event reads paginated files and shares explicit base/head with Turbo', () => {
  const { result, calls } = eventOutput(
    'pull_request',
    {
      number: 629,
      pull_request: {
        base: { sha: base },
        head: { sha: head },
        changed_files: 1,
      },
    },
    [
      [
        {
          filename: 'apps/api/src/features/notes/notes.service.ts',
          status: 'modified',
        },
      ],
    ],
  );
  assert.equal(result.base, base);
  assert.equal(result.head, head);
  assert.equal(result.affected, true);
  assert.equal(result.api, true);
  assert.equal(result.web, false);
  assert.equal(result.publish, false);
  assert.ok(calls[0].includes('--paginate'));
  assert.ok(calls[0].includes('--slurp'));
  assert.ok(JSON.parse(result.expected).includes('e2e'));
});

test('paths outside the workspace graph keep whole-workspace affected validation', () => {
  const { result } = eventOutput(
    'pull_request',
    {
      number: 630,
      pull_request: {
        base: { sha: base },
        head: { sha: head },
        changed_files: 2,
      },
    },
    [
      [
        {
          filename: 'apps/api/src/features/notes/notes.service.ts',
          status: 'modified',
        },
        { filename: 'caddy/Caddyfile', status: 'modified' },
      ],
    ],
  );
  assert.equal(result.full, false);
  assert.equal(result.api, true);
  assert.equal(result.web, true);
  assert.equal(result.affected, false);
});

test('ordinary main uses before/head comparisons rather than unconditional full validation', () => {
  const { result, calls } = eventOutput(
    'push',
    { before: base },
    {
      status: 'ahead',
      files: [{ filename: 'apps/web/src/main.tsx', status: 'modified' }],
    },
    { planning: (flags) => ({ publish: flags.code }) },
  );
  assert.ok(calls[0][1].endsWith(`compare/${base}...${head}`));
  assert.equal(result.api, false);
  assert.equal(result.web, true);
  assert.equal(result.full, false);
  assert.ok(!JSON.parse(result.expected).includes('e2e'));
});

test('CI-only main pushes do not require a trusted release manifest', () => {
  const { result } = eventOutput(
    'push',
    { before: base },
    {
      status: 'ahead',
      files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }],
    },
  );
  assert.equal(result.publish, false);
  assert.deepEqual(JSON.parse(result.expected), ['changes', 'ci-validate']);
});

test('API failures and truncated comparisons run comprehensively', () => {
  for (const response of [
    Error('API unavailable'),
    [[{ filename: 'apps/web/one.ts', status: 'modified' }]],
  ]) {
    const { result } = eventOutput(
      'pull_request',
      {
        number: 629,
        pull_request: {
          base: { sha: base },
          head: { sha: head },
          changed_files: 2,
        },
      },
      response,
    );
    assert.ok(result.full && result.api && result.web);
    assert.ok(JSON.parse(result.expected).includes('template-without-notes'));
  }
});

test('weekday nights scan the images and dependencies; Sunday validates everything', () => {
  const expected = (schedule) =>
    JSON.parse(eventOutput('schedule', { schedule }, null).result.expected);
  assert.deepEqual(expected(NIGHTLY_CRON), [
    'changes',
    'security',
    'image',
    'backup-image',
    'caddy-image',
    'gotenberg-image',
  ]);
  for (const job of ['e2e', 'template-without-notes', 'check'])
    assert.ok(expected('17 3 * * 0').includes(job), job);
});

test('a release (changelog, manifest, root version) runs no tests and publishes a manifest on main', () => {
  const files = [
    { filename: 'CHANGELOG.md', status: 'modified' },
    { filename: '.release-please-manifest.json', status: 'modified' },
    { filename: 'package.json', status: 'modified' },
  ];
  const pr = eventOutput(
    'pull_request',
    {
      number: 1047,
      pull_request: {
        base: { sha: base },
        head: { sha: head },
        changed_files: 3,
      },
    },
    [files],
    { bumped: (from, to) => from === base && to === head },
  ).result;
  assert.deepEqual(JSON.parse(pr.expected), ['changes']);
  assert.equal(pr.publish, false);
  const main = eventOutput(
    'push',
    { before: base },
    { status: 'ahead', files },
    { planning: (flags) => ({ publish: flags.code }), bumped: () => true },
  ).result;
  assert.deepEqual(JSON.parse(main.expected), ['changes']);
  assert.equal(main.publish, true);
  // Any other package.json change validates the applications.
  const other = eventOutput(
    'push',
    { before: base },
    { status: 'ahead', files },
    { planning: (flags) => ({ publish: flags.code }) },
  ).result;
  assert.ok(other.api && other.web);
  assert.ok(JSON.parse(other.expected).includes('e2e'));
});

test('scheduled, manual and version-tag events validate comprehensively; only a bootstrap publishes', () => {
  for (const name of ['schedule', 'workflow_dispatch', 'push']) {
    const { result, calls } = eventOutput(name, {}, null, {
      ref: name === 'push' ? 'refs/tags/v1.2.3' : 'refs/heads/main',
    });
    assert.equal(calls.length, 0);
    assert.equal(result.full, true);
    assert.equal(result.publish, false);
  }
  const { result } = eventOutput(
    'workflow_dispatch',
    { inputs: { bootstrap_release: 'true' } },
    null,
  );
  assert.equal(result.publish, true);
  assert.ok(result.api_image && result.caddy && result.gotenberg);
});
