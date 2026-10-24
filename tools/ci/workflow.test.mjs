// Guards on .github/workflows/ci.yml that only a run of the workflow would
// otherwise show. No YAML parser: the workflow is read as text, one step at
// a time (a step is a "- " line and the lines indented under it).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOW = new URL('../../.github/workflows/ci.yml', import.meta.url);

/** The steps of the workflow as arrays of lines. */
function steps(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\s*)- /.exec(lines[i]);
    if (!start) continue;
    const indent = start[1].length;
    const step = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() !== '' && line.search(/\S/) <= indent) break;
      step.push(line);
    }
    found.push(step);
  }
  return found;
}

/** A step's `key: value` line (the value as written), or undefined. */
function field(step, key) {
  const line = step.find((l) => l.trim().startsWith(`${key}:`));
  return line?.slice(line.indexOf(':') + 1).trim();
}

/** Each path an upload-artifact step uploads (`path: a` or a `|` list). */
function uploadPaths(step) {
  const at = step.findIndex((l) => l.trim().startsWith('path:'));
  const value = field(step, 'path');
  if (value !== '|') return [value];
  const indent = step[at].search(/\S/);
  return step
    .slice(at + 1)
    .filter((l) => l.trim() !== '' && l.search(/\S/) > indent)
    .map((l) => l.trim());
}

/** What is wrong with the workflow's artifact uploads, as sentences. */
function problems(text) {
  const out = [];
  const uploads = steps(text).filter((s) =>
    s.some((l) => l.includes('uses: actions/upload-artifact@')),
  );
  for (const step of uploads) {
    const name = field(step, 'name');
    for (const path of uploadPaths(step)) {
      // upload-artifact skips hidden files and directories unless asked.
      const hidden = path.split('/').some((part) => part.startsWith('.'));
      if (hidden && field(step, 'include-hidden-files') !== 'true') {
        out.push(`${name}: ${path} is hidden, set include-hidden-files: true`);
      }
    }
    if (name?.startsWith('coverage-')) {
      // A shard's blob report is what the coverage job merges: an empty
      // upload must fail the shard, not leave the merge nothing to read.
      if (field(step, 'if-no-files-found') !== 'error') {
        out.push(`${name}: set if-no-files-found: error`);
      }
      // Vitest's --merge-reports reads one flat directory of blob files. A
      // glob over apps/* stores them under api/ or web/, which it can't read.
      for (const path of uploadPaths(step)) {
        if (path.includes('*')) {
          out.push(
            `${name}: ${path} nests the blobs, upload one app's directory`,
          );
        }
      }
    }
  }
  return out;
}

test('the workflow uploads its hidden blob reports, and fails when there are none', () => {
  assert.deepEqual(problems(readFileSync(WORKFLOW, 'utf8')), []);
});

test("the coverage shards upload one app's blob directory", () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const shard = steps(text).find((s) =>
    field(s, 'name')?.startsWith('coverage-'),
  );
  assert.ok(shard, 'the unit job uploads a coverage-* artifact');
  assert.deepEqual(uploadPaths(shard), [
    'apps/${{ matrix.app }}/.vitest/blob/',
  ]);
});

test('a hidden path without include-hidden-files, and a glob, are reported', () => {
  const before = `
      - name: The shard's blob report
        uses: actions/upload-artifact@v7
        with:
          name: coverage-api-1
          path: apps/*/.vitest/blob/
          retention-days: 1
`;
  assert.deepEqual(problems(before), [
    'coverage-api-1: apps/*/.vitest/blob/ is hidden, set include-hidden-files: true',
    'coverage-api-1: set if-no-files-found: error',
    "coverage-api-1: apps/*/.vitest/blob/ nests the blobs, upload one app's directory",
  ]);
});

test('the K3s release rolls back and waits with Helm legacy status checks', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const all = steps(text);
  const upgrade = all.find(
    (s) => s[0].trim() === '- name: Upgrade to the CI-verified release',
  );
  assert.ok(upgrade, 'the deploy job has a named Helm upgrade step');
  assert.match(
    upgrade.join('\n'),
    /--rollback-on-failure --wait=legacy --wait-for-jobs --timeout 12m/,
  );

  const rollouts = [
    ['API', 'deployment/app-api'],
    ['web', 'deployment/app-web'],
    ['worker', 'deployment/app-worker'],
    ['Gotenberg', 'deployment/app-gotenberg'],
  ];
  for (const [name, deployment] of rollouts) {
    const step = all.find(
      (s) => s[0].trim() === `- name: Verify ${name} rollout`,
    );
    assert.ok(step, `the deploy job has a separate ${name} rollout step`);
    assert.ok(
      step.join('\n').includes(`rollout status ${deployment} --timeout=3m`),
    );
  }
});

test('client and migration workflows do not run on unrelated pull requests', () => {
  const cases = [
    [
      'api-client.yml',
      ['packages/api-client/**', 'apps/api/**', '.changeset/**'],
    ],
    ['migrations.yml', ['apps/api/drizzle/**', 'tools/migration-lint/**']],
  ];
  for (const [name, relevantPaths] of cases) {
    const workflow = readFileSync(
      new URL(`../../.github/workflows/${name}`, import.meta.url),
      'utf8',
    );
    const triggers = workflow.slice(0, workflow.indexOf('\npermissions:'));
    assert.match(
      triggers,
      /  pull_request:\n(?:    (?:types: [^\n]*|#[^\n]*)\n)*    paths:/,
      name,
    );
    for (const file of relevantPaths) {
      assert.ok(
        triggers.includes(`      - ${file}`),
        `${name} must run for ${file}`,
      );
    }
  }
});
