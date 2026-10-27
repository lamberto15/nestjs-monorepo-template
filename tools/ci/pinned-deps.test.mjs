import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, isExact, rangesOf } from './pinned-deps.mjs';

test('the workspace pins every dependency exactly', () => {
  assert.deepEqual(check(), []);
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
