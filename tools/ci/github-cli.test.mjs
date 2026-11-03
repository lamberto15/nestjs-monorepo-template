import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute } from './github-cli.mjs';

test("commands may print more than Node's 1 MB default buffer", () => {
  // A page of 100 workflow runs from the API is about that size (v0.1.0's
  // promotion failed with ENOBUFS).
  const size = 3 * 1024 * 1024;
  const output = execute(process.execPath, [
    '-e',
    `process.stdout.write('x'.repeat(${size}))`,
  ]);
  assert.equal(output.length, size);
});
