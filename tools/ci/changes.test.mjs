// Which jobs of .github/workflows/ci.yml a pull request runs: the `changes`
// job's step, run by bash on sample file lists (`gh` stubbed to print them),
// then every job's `needs` and `if` applied as GitHub applies them (a job
// whose `needs` didn't all succeed is skipped, unless its `if` calls a
// status function such as `!cancelled()`). No YAML parser, as in
// workflow.test.mjs: the workflow is read as text. Each case prints the jobs
// it runs: `node --test --test-reporter=spec tools/ci/changes.test.mjs`.
// Needs bash and grep, as the step does (CI's runners and macOS have them).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const WORKFLOW = new URL('../../.github/workflows/ci.yml', import.meta.url);
const TEXT = readFileSync(WORKFLOW, 'utf8');

/** The workflow's jobs, in order: id, needs, the job-level `if` (or ''). */
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  assert.ok(start >= 0, 'the workflow has a jobs: key');
  const found = [];
  let job;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const header = /^ {2}([a-z0-9_-]+):$/.exec(line);
    if (header) {
      job = { id: header[1], needs: [], if: '', lines: [] };
      found.push(job);
      continue;
    }
    if (!job) continue;
    job.lines.push(line);
    const needs = /^ {4}needs: (.+)$/.exec(line);
    if (needs) {
      job.needs = needs[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
    }
    const condition = /^ {4}if: (.+)$/.exec(line);
    if (condition) {
      let value = condition[1].trim();
      // A folded block (`>-`): the lines indented under it, joined.
      if (/^[>|]-?$/.test(value)) {
        const block = [];
        while (i + 1 < lines.length && /^ {6}\S/.test(lines[i + 1])) {
          block.push(lines[++i].trim());
        }
        value = block.join(' ');
      }
      job.if = value.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
    }
  }
  return found;
}

/** The `changes` job's `run: |` script, unindented. */
function changesScript(text) {
  const job = jobs(text).find((j) => j.id === 'changes');
  assert.ok(job, 'the workflow has a changes job');
  const at = job.lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.ok(at >= 0, 'the changes job has a run: | step');
  const script = [];
  for (const line of job.lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    script.push(line.slice(10));
  }
  return script.join('\n');
}

/** The outputs the changes job declares. */
function declaredOutputs(text) {
  const job = jobs(text).find((j) => j.id === 'changes');
  return job.lines
    .map((l) =>
      /^ {6}([a-z]+): \$\{\{ steps\.paths\.outputs\.([a-z]+) \}\}$/.exec(l),
    )
    .filter(Boolean)
    .map((m) => {
      assert.equal(
        m[1],
        m[2],
        `output ${m[1]} reads steps.paths.outputs.${m[2]}`,
      );
      return m[1];
    });
}

const work = mkdtempSync(path.join(tmpdir(), 'ci-changes-'));
after(() => rmSync(work, { recursive: true, force: true }));
// `gh api …/files` prints the sample's paths (the step's --jq output).
const bin = path.join(work, 'bin');
mkdirSync(bin);
writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\ncat "$SAMPLE_FILES"\n');
chmodSync(path.join(bin, 'gh'), 0o755);
const script = path.join(work, 'changes.sh');
writeFileSync(script, changesScript(TEXT));

let runs = 0;
/** Runs the changes step for an event and changed paths: its outputs. */
function classify(files, event = 'pull_request', ref = 'refs/heads/main') {
  const id = ++runs;
  const sample = path.join(work, `files-${id}`);
  const output = path.join(work, `output-${id}`);
  writeFileSync(sample, files.join('\n') + '\n');
  writeFileSync(output, '');
  // bash -e, as a `run` step without `shell:` runs on Linux.
  execFileSync('bash', ['--noprofile', '--norc', '-e', script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      CI_BEFORE: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'unused',
      PR: '1',
      SAMPLE_FILES: sample,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const outputs = {};
  for (const line of readFileSync(output, 'utf8').split('\n')) {
    const m = /^([a-z]+)=(.*)$/.exec(line);
    if (m) {
      assert.ok(!(m[1] in outputs), `${m[1]} is written once`);
      outputs[m[1]] = m[2];
    }
  }
  return outputs;
}

// GitHub's expressions, the part the workflow's job-level `if`s use:
// literals, context paths, ! == != && || ( ), and a few functions.
function evaluate(expression, context) {
  const tokens = expression.match(
    /\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][\w.-]*|\d+|\S/g,
  );
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected) => {
    const token = tokens[at++];
    if (expected && token !== expected) {
      throw new Error(`expected ${expected}, got ${token} in ${expression}`);
    }
    return token;
  };
  const equal = (a, b) =>
    typeof a === 'string' && typeof b === 'string'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  function or() {
    let value = and();
    while (peek() === '||') {
      take();
      const right = and();
      value = value || right;
    }
    return value;
  }
  function and() {
    let value = not();
    while (peek() === '&&') {
      take();
      const right = not();
      value = value && right;
    }
    return value;
  }
  function not() {
    if (peek() === '!') {
      take();
      return !not();
    }
    let value = primary();
    if (peek() === '==' || peek() === '!=') {
      const op = take();
      const right = primary();
      value = op === '==' ? equal(value, right) : !equal(value, right);
    }
    return value;
  }
  function primary() {
    const token = take();
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (/^\d+$/.test(token)) return Number(token);
    if (token === 'true' || token === 'false') return token === 'true';
    if (peek() === '(') {
      take('(');
      const args = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') take(',');
      }
      take(')');
      const fn = context.functions[token];
      if (!fn) throw new Error(`no function ${token} in ${expression}`);
      return fn(...args);
    }
    return (
      token
        .split('.')
        .reduce(
          (value, key) => (value == null ? undefined : value[key]),
          context.values,
        ) ?? ''
    );
  }
  const value = or();
  if (at !== tokens.length) throw new Error(`left over in ${expression}`);
  return value;
}

const STATUS = /\b(success|failure|always|cancelled)\(\)/;

/**
 * The jobs an event runs, every job that runs succeeding: { ran, outputs }.
 * ref: github.ref (a tag for a release).
 */
function simulate(
  files,
  {
    event = 'pull_request',
    ref = 'refs/heads/main',
    deployEnabled = false,
  } = {},
) {
  const outputs = classify(files, event, ref);
  const results = {};
  const all = jobs(TEXT);
  const pending = [...all];
  while (pending.length > 0) {
    const index = pending.findIndex((j) => j.needs.every((n) => n in results));
    assert.ok(
      index >= 0,
      `needs form no cycle and name jobs: ${pending.map((j) => j.id)}`,
    );
    const [job] = pending.splice(index, 1);
    const needs = Object.fromEntries(
      job.needs.map((n) => [
        n,
        {
          result: results[n],
          outputs: n === 'changes' && results[n] === 'success' ? outputs : {},
        },
      ]),
    );
    const succeeded = job.needs.every((n) => results[n] === 'success');
    const context = {
      values: {
        github: { event_name: event, ref },
        vars: { K3S_DEPLOY_ENABLED: String(deployEnabled) },
        needs,
      },
      functions: {
        success: () => succeeded,
        failure: () => job.needs.some((n) => results[n] === 'failure'),
        always: () => true,
        cancelled: () => false,
        startsWith: (a, b) =>
          String(a).toLowerCase().startsWith(String(b).toLowerCase()),
        contains: (a, b) =>
          Array.isArray(a)
            ? a.some((v) => String(v).toLowerCase() === String(b).toLowerCase())
            : String(a).toLowerCase().includes(String(b).toLowerCase()),
      },
    };
    // Without a status function, GitHub adds success(): every need ran and passed.
    const gate = job.if === '' ? true : evaluate(job.if, context);
    const runs = STATUS.test(job.if)
      ? Boolean(gate)
      : succeeded && Boolean(gate);
    results[job.id] = runs ? 'success' : 'skipped';
  }
  const ran = all.map((j) => j.id).filter((id) => results[id] === 'success');
  return { ran, outputs };
}

/** Runs a case: asserts the jobs it runs, and prints them. */
function expectJobs(t, files, expected, options) {
  const { ran, outputs } = simulate(files, options);
  t.diagnostic(
    `outputs: ${Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  t.diagnostic(`runs ${ran.length}: ${ran.join(', ')}`);
  assert.deepEqual(ran, expected);
  return outputs;
}

const ALWAYS = ['changes'];
// App-facing changes need the full build/DB check, Compose service outputs,
// and security. Tooling changes get independent lint and smoke verification.
const CODE_PREREQS = ['compose-images', 'security'];
const TOOLING_ONLY = ['compose-images', 'security'];
const PUSH_ONLY = [
  'publish',
  'publish-gotenberg',
  'publish-caddy',
  'release',
  'deploy-k3s',
];
// The jobs each output of `changes` switches on: the workflow's job-level `if`s
// read as groups. A job gated on several outputs is in each of their groups
// (`only` counts it once). A case expects ALWAYS plus the groups of the
// outputs its paths set; the images that build one thing (backup, Caddy,
// Gotenberg) are named in the case.
/** App-relevant paths need the full lint, build, client and migration checks. */
const CODE = ['check', ...CODE_PREREQS];
/** `services`: the suites that run on CI's PostgreSQL and Redis (compose.yaml). */
const SERVICES = [
  'e2e',
  'e2e-telemetry',
  'e2e-web',
  'feature-smoke',
  'template-without-notes',
];
/**
 * `api`: the API's unit tests, the services suites (they run on its code), the
 * app image, the OpenAPI diff, the hardened stack.
 */
const API = [
  'unit-api',
  'coverage',
  ...SERVICES,
  'openapi-diff',
  'image',
  'hardened-stack',
];
/** `web`: the web app's unit tests (coverage follows) and the browser tests. */
const WEB = ['unit-web', 'coverage', 'e2e-web', 'template-without-notes'];
/** `tools`: the generator's smoke test and the template check. */
const TOOLS = ['feature-smoke', 'template-without-notes'];
/** `stack`: the Compose secrets, the Swarm render, the hardened stack. */
const STACK = ['compose-secrets', 'swarm-stack', 'hardened-stack'];
/** The workflow's jobs in order, filtered by a list (keeps the order). */
const only = (...ids) =>
  jobs(TEXT)
    .map((j) => j.id)
    .filter((id) => ids.flat().includes(id));

test('a docs-only pull request runs only the change classifier', (t) => {
  expectJobs(
    t,
    [
      'docs/deployment.md',
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/skills/add-feature/SKILL.md',
      '.changeset/quiet-hours.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'packages/api-client/CHANGELOG.md',
      'LICENSE',
    ],
    only(ALWAYS),
  );
});

test('a Helm or K3s manifest pull request is left to helm.yml', (t) => {
  expectJobs(
    t,
    [
      'deploy/helm/app/values.yaml',
      'deploy/helm/app/templates/api.yaml',
      'deploy/k3s/data.yaml',
    ],
    only(ALWAYS),
  );
});

test('a web-only pull request skips the API side and the stack', (t) => {
  expectJobs(
    t,
    ['apps/web/src/main.tsx'],
    only(ALWAYS, CODE, WEB, 'caddy-image'),
  );
});

test('an API-only pull request skips the web unit tests and the images it does not build', (t) => {
  expectJobs(t, ['apps/api/src/main.ts'], only(ALWAYS, CODE, API));
});

test('a backup-only pull request builds the backup image and checks the stack', (t) => {
  expectJobs(
    t,
    ['backup/backup.sh'],
    only(ALWAYS, CODE, STACK, 'backup-image'),
  );
});

test('a Compose-only pull request checks the stack, and Gotenberg for compose.prod.yaml', (t) => {
  expectJobs(
    t,
    ['compose.prod.yaml'],
    only(ALWAYS, CODE, STACK, 'gotenberg-image'),
  );
  expectJobs(t, ['compose.monitoring.yaml'], only(ALWAYS, CODE, STACK));
});

test("compose.yaml runs every suite on CI's PostgreSQL and Redis: compose-images reads them from it", (t) => {
  // Dependabot's docker-compose updates (a new Redis or PostgreSQL) change
  // compose.yaml alone: the suites on those images must meet it before main.
  const outputs = expectJobs(
    t,
    ['compose.yaml'],
    only(ALWAYS, CODE, STACK, SERVICES),
  );
  assert.equal(outputs.services, 'true');
  // Only the root's: the devcontainer's compose.yaml is devcontainer.yml's.
  assert.equal(classify(['.devcontainer/compose.yaml']).services, 'false');
  assert.equal(classify(['compose.prod.yaml']).services, 'false');
});

test('every job whose services run compose.yaml images reads the services output', () => {
  // compose-images' outputs are the image of a service container: a job
  // with one runs on a pull request that changes compose.yaml.
  for (const job of jobs(TEXT)) {
    if (!job.lines.some((l) => /needs\.compose-images\.outputs\./.test(l))) {
      continue;
    }
    if (job.id === 'check') {
      // Gated on `app`, which compose.yaml sets too.
      assert.match(job.if, /needs\.changes\.outputs\.app == 'true'/);
      continue;
    }
    assert.match(
      job.if,
      /needs\.changes\.outputs\.services == 'true'/,
      `${job.id} runs on compose.yaml's images: gate it on services too`,
    );
  }
});

test("tooling-only changes lint and smoke-test generators without DB-backed app checks", (t) => {
  const inputs = expectJobs(t, ['tools/feature/add.mjs'], only(ALWAYS, TOOLING_ONLY, TOOLS));
  assert.equal(inputs.code, 'true');
  assert.equal(inputs.app, 'false');
  assert.equal(inputs.lint, 'true');
  expectJobs(t, ['tools/deploy/swarm.mjs'], only(ALWAYS, TOOLING_ONLY, TOOLS, STACK));
});

test("the Caddyfile runs the web unit tests (one reads it) and Caddy's image", (t) => {
  expectJobs(
    t,
    ['caddy/Caddyfile'],
    only(ALWAYS, CODE, STACK, WEB, 'caddy-image'),
  );
});

test('the lockfile runs everything that installs or builds the workspace', (t) => {
  expectJobs(
    t,
    ['pnpm-lock.yaml'],
    only(ALWAYS, CODE, API, WEB, 'caddy-image'),
  );
});

test('generator smoke reuses its runner for tooling-only lint', () => {
  const smoke = jobs(TEXT).find((job) => job.id === 'feature-smoke');
  const text = smoke.lines.join('\n');
  assert.match(text, /- name: Lint tooling and unused dependencies\n\s+if: needs\.changes\.outputs\.lint == 'true' && needs\.changes\.outputs\.app != 'true'\n\s+run: pnpm lint/);
  const lint = jobs(TEXT).find((job) => job.id === 'tooling-lint');
  assert.match(lint.if, /needs\.changes\.outputs\.tools != 'true'/);
});

test('Knip config alone gets lint, without containers, app builds or security scans', (t) => {
  const outputs = expectJobs(t, ['knip.jsonc'], only(ALWAYS, 'tooling-lint'));
  assert.equal(outputs.code, 'true');
  assert.equal(outputs.app, 'false');
  assert.equal(outputs.lint, 'true');
});

test('the agent documentation PR runs generator checks but not unrelated app validation', (t) => {
  const outputs = expectJobs(
    t,
    [
      '.claude/skills/add-feature/SKILL.md',
      '.github/workflows/ci.yml',
      'AGENTS.md',
      'CLAUDE.md',
      'CONTRIBUTING.md',
      'docs/development.md',
      'docs/upgrading.md',
      'knip.jsonc',
      'tools/ci/changes.test.mjs',
      'tools/feature/add.mjs',
      'tools/feature/remove.mjs',
    ],
    only(ALWAYS, 'ci-validate', TOOLING_ONLY, TOOLS),
  );
  assert.equal(outputs.api, 'false');
  assert.equal(outputs.web, 'false');
  assert.equal(outputs.app, 'false');
});

test('a tooling and API change runs the full check without duplicate lint', (t) => {
  const outputs = expectJobs(
    t,
    ['tools/feature/add.mjs', 'apps/api/src/main.ts', 'knip.jsonc'],
    only(ALWAYS, CODE, API, TOOLS),
  );
  assert.equal(outputs.app, 'true');
  assert.equal(outputs.lint, 'true');
});

test('unknown root config is app-relevant rather than silently excluded', (t) => {
  expectJobs(t, ['new-config.jsonc'], only(ALWAYS, CODE));
});

test('other workflow-only edits run CI validation, not unrelated application checks', (t) => {
  expectJobs(t, ['.github/workflows/web.yml'], only(ALWAYS, 'ci-validate'));
  expectJobs(t, ['.github/workflows/migrations.yml'], only(ALWAYS, 'ci-validate'));
});

test('CI workflow-only PRs validate routing without any app, e2e or image jobs', (t) => {
  const outputs = expectJobs(
    t,
    ['.github/workflows/ci.yml', 'tools/ci/workflow.test.mjs'],
    only(ALWAYS, 'ci-validate'),
  );
  assert.equal(outputs.ci, 'true');
  for (const key of ['code', 'api', 'web', 'tools', 'stack', 'services', 'backup', 'gotenberg', 'caddy']) {
    assert.equal(outputs[key], 'false', key);
  }
});

test('CI config and API changes both run, without accidentally testing the web app', (t) => {
  expectJobs(
    t,
    ['.github/workflows/ci.yml', 'apps/api/src/main.ts'],
    only(ALWAYS, CODE, API, 'ci-validate'),
  );
});

test('CI-only main merges skip publishing and K3s; app changes keep full validation', (t) => {
  expectJobs(
    t,
    ['.github/workflows/ci.yml', '.github/workflows/migrations.yml', 'tools/ci/changes.test.mjs'],
    only(ALWAYS, 'ci-validate'),
    { event: 'push' },
  );
  const regular = simulate(['apps/api/src/main.ts'], { event: 'push' });
  assert.ok(regular.ran.includes('publish'));
  assert.ok(regular.ran.includes('publish-caddy'));
  assert.ok(regular.ran.includes('publish-gotenberg'));
});

test('a file moved out of the API counts at its old path', (t) => {
  // The stub prints what the step's --jq prints: new and previous names.
  const { outputs } = simulate([
    'docs/old-notes.md',
    'apps/api/src/old-notes.md',
  ]);
  assert.equal(outputs.api, 'true');
  t.diagnostic('apps/api/src/old-notes.md -> docs/old-notes.md: api=true');
});

test("a list at the API's 3000-file limit runs everything", () => {
  const files = Array.from({ length: 3000 }, (_, i) => `docs/page-${i}.md`);
  const outputs = classify(files);
  assert.ok(
    Object.values(outputs).every((v) => v === 'true'),
    JSON.stringify(outputs),
  );
});

test('main can deploy only when enabled; tags and the nightly run never do', (t) => {
  // tooling-lint never duplicates lint on full pushes, tags or nightly checks.
  const every = jobs(TEXT).map((j) => j.id).filter((id) => id !== 'tooling-lint');
  expectJobs(
    t,
    [],
    every.filter((id) => !['openapi-diff', 'release'].includes(id)),
    { event: 'push', deployEnabled: true },
  );
  expectJobs(
    t,
    [],
    every.filter((id) => id !== 'openapi-diff' && id !== 'deploy-k3s'),
    { event: 'push', ref: 'refs/tags/v1.2.3', deployEnabled: true },
  );
  expectJobs(
    t,
    [],
    every.filter((id) => id !== 'openapi-diff' && !PUSH_ONLY.includes(id)),
    { event: 'schedule' },
  );
  const disabled = simulate([], { event: 'push' });
  assert.ok(!disabled.ran.includes('deploy-k3s'));
});

test('the classifier writes every declared output, in both branches', () => {
  const declared = declaredOutputs(TEXT).sort();
  assert.deepEqual(Object.keys(classify(['docs/a.md'])).sort(), declared);
  assert.deepEqual(Object.keys(classify([], 'push')).sort(), declared);
});

test('every job reads a declared output, or is one of the few that always run', () => {
  const declared = declaredOutputs(TEXT);
  // Cheap or pull-request-wide: the classifier, the images CI's services
  // read, the scans; coverage follows the unit jobs; the publish chain runs
  // on main and tags only, where nothing is skipped.
  const exempt = new Set([...ALWAYS, 'coverage', ...PUSH_ONLY]);
  for (const job of jobs(TEXT)) {
    const used = [...job.if.matchAll(/needs\.changes\.outputs\.([a-z]+)/g)].map(
      (m) => m[1],
    );
    for (const key of used) {
      assert.ok(
        declared.includes(key),
        `${job.id} reads ${key}, which changes doesn't declare`,
      );
      assert.ok(
        job.needs.includes('changes'),
        `${job.id} reads changes' outputs without needing it`,
      );
    }
    if (!exempt.has(job.id)) {
      assert.ok(
        used.length > 0,
        `${job.id} runs on every pull request: gate it on the paths it reads (an output of changes)`,
      );
    }
  }
});

test('coverage merges the side whose unit job ran, and skips when none did', () => {
  const coverage = jobs(TEXT).find((j) => j.id === 'coverage');
  const runs = (api, web) =>
    Boolean(
      evaluate(coverage.if, {
        values: {
          needs: { 'unit-api': { result: api }, 'unit-web': { result: web } },
        },
        functions: { cancelled: () => false },
      }),
    );
  assert.equal(runs('success', 'success'), true);
  assert.equal(runs('success', 'skipped'), true);
  assert.equal(runs('skipped', 'success'), true);
  assert.equal(runs('skipped', 'skipped'), false);
  assert.equal(runs('failure', 'success'), false);
  assert.equal(runs('success', 'cancelled'), false);
  // Each side's steps follow its unit job's result.
  const steps = coverage.lines.join('\n');
  for (const [side, job] of [
    ['API', 'unit-api'],
    ['web app', 'unit-web'],
  ]) {
    for (const name of [`The ${side}'s shards`, `The ${side}'s coverage`]) {
      const step = new RegExp(
        `- name: ${name}\\n\\s+if: needs\\.${job}\\.result == 'success'\\n`,
      );
      assert.match(steps, step, `${name} runs only when ${job} ran`);
    }
  }
});


test('runner-heavy matrices leave capacity for other pull requests', () => {
  for (const id of ['unit-api', 'unit-web', 'e2e', 'template-without-notes']) {
    const job = jobs(TEXT).find((candidate) => candidate.id === id);
    assert.match(job.lines.join('\n'), /    strategy:\n      fail-fast: false\n      # Reserve runner capacity for other pull requests\.\n      max-parallel: 2\n/, id);
  }
});

test('doc-only merges do not trigger full main CI while release tags stay enabled', () => {
  assert.match(TEXT, /push:\n    branches: \[main\]\n    tags: \['v\*'\]\n    # Documentation-only merges/);
  assert.match(TEXT, /paths-ignore:\n      - 'docs\/\*\*'/);
});
