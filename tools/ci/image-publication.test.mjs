import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);
function script(job, name) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, job);
  const next = workflow.slice(start + 3).search(/^  [a-z][a-z0-9-]*:/m);
  const block = workflow.slice(start, next < 0 ? undefined : start + 3 + next);
  const lines = block.split('\n');
  const at = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(at >= 0, name);
  const run = lines.findIndex(
    (line, index) => index > at && line === '        run: |',
  );
  assert.ok(run > at, name);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n').replaceAll('${{ runner.temp }}', '$RUNNER_TEMP');
}

test(
  'actual export/load/push scripts preserve the verified image in a disposable registry',
  { skip: process.env.REQUIRE_DOCKER !== 'true' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-image-'));
    const address = process.env.CI_REGISTRY_ADDRESS;
    assert.match(
      address ?? '',
      /^127\.0\.0\.1:\d+$/,
      'a disposable loopback registry is required',
    );
    const docker = (args) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    try {
      docker(['info']);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const response = await fetch(`http://${address}/v2/`);
          ready = response.ok;
          await response.arrayBuffer();
          if (ready) break;
        } catch {
          /* The disposable service may still be starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'the disposable registry is ready');
      const repository = `${address}/ci-handoff`;
      execFileSync('docker', ['build', '-t', 'app:ci', '-'], {
        input: 'FROM scratch\nLABEL ci.handoff="verified"\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const original = docker([
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        'app:ci',
      ]).trim();
      const output = join(directory, 'outputs');
      writeFileSync(output, '');
      const env = {
        ...process.env,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        GITHUB_SHA: 'a'.repeat(40),
        REPOSITORY: repository,
        TAGS: `${repository}:${'a'.repeat(40)}\n${repository}:verification`,
      };
      const bash = (source) =>
        execFileSync('bash', ['-e', '-c', source], { env, stdio: 'pipe' });
      bash(script('image', 'Export the verified image'));
      mkdirSync(join(directory, 'image'));
      for (const name of ['app.tar', 'app.tar.sha256', 'app.id'])
        renameSync(join(directory, name), join(directory, 'image', name));
      docker(['image', 'rm', 'app:ci']);
      bash(script('publish', 'Load the verified image'));
      assert.equal(
        docker(['image', 'inspect', '--format', '{{.Id}}', 'app:ci']).trim(),
        original,
      );
      bash(script('publish', 'Push without rebuilding'));
      const results = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );
      assert.match(results.digest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(results.ref, `${repository}@${results.digest}`);
      docker(['pull', results.ref]);
      assert.equal(
        docker(['image', 'inspect', '--format', '{{.Id}}', results.ref]).trim(),
        original,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
