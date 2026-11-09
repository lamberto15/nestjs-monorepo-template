import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  check,
  isExact,
  PNPM_DOCKERFILES,
  pnpmVersionProblems,
  rangesOf,
} from './pinned-deps.mjs';

test('the workspace pins every dependency exactly', () => {
  assert.deepEqual(check(), []);
});

test('the workspace names one pnpm version in devEngines and the Dockerfiles', () => {
  assert.deepEqual(pnpmVersionProblems(), []);
});

/** A checkout with the given devEngines pnpm version and Dockerfile image tags. */
function checkout(devEngines, tags) {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-deps-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      devEngines: devEngines && {
        packageManager: { name: 'pnpm', version: devEngines },
      },
    }),
  );
  PNPM_DOCKERFILES.forEach((file, i) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(
      join(dir, file),
      `# syntax=docker/dockerfile:1\nFROM ghcr.io/pnpm/pnpm:${tags[i]} AS base\nFROM node:26-slim\n`,
    );
  });
  return dir;
}

test('pnpmVersionProblems names each Dockerfile whose image tag differs', () => {
  assert.deepEqual(
    pnpmVersionProblems(checkout('12.18.0', ['12.18.0', '12.18.0'])),
    [],
  );
  assert.deepEqual(
    pnpmVersionProblems(checkout('12.15.0', ['12.17.0', '12.15.0'])),
    [
      'apps/api/Dockerfile: ghcr.io/pnpm/pnpm:12.17.0 but package.json devEngines names pnpm 12.15.0',
    ],
  );
  assert.deepEqual(pnpmVersionProblems(checkout(undefined, ['1', '1'])), [
    'package.json: devEngines.packageManager.version is not set',
  ]);
});

test('exact versions, prereleases and non-registry specifiers pass', () => {
  for (const s of [
    '1.2.3',
    '0.0.1',
    '7.0.2004',
    '1.0.0-rc.1',
    '1.0.0+build.5',
    'workspace:*',
    'catalog:',
    'file:../x',
    'npm:left-pad@1.3.0',
  ]) {
    assert.ok(isExact(s), s);
  }
});

test('ranges, wildcards and tags fail', () => {
  for (const s of [
    '^1.2.3',
    '~1.2.3',
    '>=1.0.0',
    '>1.0.0',
    '*',
    'x',
    '1.x',
    '1.2.x',
    '1',
    '1.2',
    '1.0.0 - 2.0.0',
    '^1 || ^2',
    'latest',
    'npm:left-pad@^1.3.0',
  ]) {
    assert.ok(!isExact(s), s);
  }
});

test('rangesOf reports the section, name and specifier, and ignores peer ranges', () => {
  const pkg = {
    dependencies: { a: '1.0.0', b: '^2.0.0' },
    devDependencies: { c: '~3.1.0' },
    optionalDependencies: { d: '*' },
    peerDependencies: { e: '^4.0.0' },
    engines: { node: '^24.0.0' },
  };
  assert.deepEqual(rangesOf(pkg), [
    'dependencies: b@^2.0.0',
    'devDependencies: c@~3.1.0',
    'optionalDependencies: d@*',
  ]);
});
