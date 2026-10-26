import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classify, expectedJobs } from './changes.mjs';
const text = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);
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
    if (line === '    needs:') {
      const block = [];
      while (i + 1 < lines.length && /^ {6}/.test(lines[i + 1]))
        block.push(lines[++i].trim());
      job.needs = block
        .join('')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
    }
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

function actual(flags, { event = 'pull_request' } = {}) {
  const all = jobs(text).slice(
    0,
    jobs(text).findIndex((j) => j.id === 'ci-gate'),
  );
  const outputs = Object.fromEntries(
    Object.entries(flags).map(([k, v]) => [
      k,
      String(v),
    ]),
  );
  const results = {};
  for (const job of all) {
    const needs = Object.fromEntries(
      job.needs.map((id) => [
        id,
        { result: results[id], outputs: id === 'changes' ? outputs : {} },
      ]),
    );
    const succeeded = job.needs.every((id) => results[id] === 'success');
    const context = {
      values: { needs, github: { event_name: event } },
      functions: { cancelled: () => false },
    };
    const condition = !job.if || evaluate(job.if, context);
    const status = /\b(cancelled|always|success|failure)\(\)/.test(job.if);
    results[job.id] =
      condition && (status || succeeded) ? 'success' : 'skipped';
  }
  return Object.keys(results).filter((k) => results[k] === 'success');
}
test('real workflow conditions and dependencies agree with the gate for affected and full runs', () => {
  for (const file of [
    'apps/api/src/features/notes/notes.service.ts',
    'apps/web/src/routes/index.tsx',
    'packages/ui/src/button.tsx',
    'packages/api-client/src/client.ts',
    'apps/api/src/platform/fields/index.ts',
    'apps/api/drizzle/a.sql',
    'compose.yaml',
    'caddy/Caddyfile',
    'gotenberg/Dockerfile',
    'tools/feature/add.mjs',
    'tools/deploy/rolling.mjs',
    'knip.jsonc',
    '.trivyignore.yaml',
    'docs/deployment.md',
    'deploy/helm/app/values.yaml',
    '.github/workflows/ci.yml',
    'unknown',
  ]) {
    const flags = classify({ files: [file] });
    for (const event of ['pull_request', 'push'])
      assert.deepEqual(
        actual(flags, { event }).sort(),
        expectedJobs(flags).sort(),
        file + ' ' + event,
      );
  }
  for (const event of ['schedule', 'workflow_dispatch', 'push']) {
    const flags = classify({ full: true });
    assert.deepEqual(
      actual(flags, { event }).sort(),
      expectedJobs(flags).sort(),
      event,
    );
  }
});
test('the stable gate needs every validation job and production rollout is disabled', () => {
  const all = jobs(text),
    gate = all.find((j) => j.id === 'ci-gate');
  assert.equal(gate.if, 'always()');
  assert.deepEqual(
    gate.needs,
    all.slice(0, all.indexOf(gate)).map((j) => j.id),
  );
  assert.match(all.find((j) => j.id === 'deploy-k3s').if, /^false &&/);
  for (const id of [
    'publish',
    'publish-caddy',
    'publish-gotenberg',
    'release-manifest',
    'release',
    'deploy-k3s',
  ])
    assert.ok(all.find((j) => j.id === id).needs.includes('ci-gate'), id);
});

test('every release image is built once and handed off with integrity evidence', () => {
  const all = jobs(text);
  for (const [builder, publisher, image] of [
    ['image', 'publish', 'app'],
    ['caddy-image', 'publish-caddy', 'caddy'],
    ['gotenberg-image', 'publish-gotenberg', 'gotenberg'],
  ]) {
    const build = all.find((job) => job.id === builder).lines.join('\n');
    assert.equal(
      (build.match(/uses: docker\/build-push-action@/g) ?? []).length,
      1,
      builder,
    );
    assert.ok(build.includes(`name: image-${image}`), builder);
    assert.ok(build.includes(`${image}.tar.sha256`), builder);
    assert.ok(build.includes(`${image}.id`), builder);
    // Handed over only to this run's publish job: a pull request uploads none.
    assert.ok(
      build.includes(
        "- name: Transfer the verified image\n        if: needs.changes.outputs.publish == 'true'",
      ),
      builder,
    );
    const publish = all.find((job) => job.id === publisher).lines.join('\n');
    assert.ok(!publish.includes('uses: docker/build-push-action@'), publisher);
    assert.ok(publish.includes(`sha256sum -c ${image}.tar.sha256`), publisher);
    assert.ok(
      publish.includes('image-ref: ${{ steps.push.outputs.ref }}'),
      publisher,
    );
    assert.ok(
      publish.indexOf('image-ref:') <
        publish.indexOf('uses: ./.github/actions/sign-image'),
      publisher,
    );
  }
});
