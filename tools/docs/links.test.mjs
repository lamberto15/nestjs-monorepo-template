import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownLinks } from './links.mjs';

test('extracts local destinations from links, images and optional quoted titles', () => {
  assert.deepEqual(
    [...markdownLinks('[docs](docs/start.md) ![img](images/logo.png) [a](a.md "caption") [b](b.md \'caption\')')],
    ['docs/start.md', 'images/logo.png', 'a.md', 'b.md'],
  );
});

test('does not extract empty or malformed link destinations', () => {
  assert.deepEqual([...markdownLinks('[missing]() [bad](path wrong) [broken](path')], []);
});

test('handles a large malformed Markdown line without backtracking', () => {
  assert.deepEqual([...markdownLinks('[a]('.repeat(30_000))], []);
});
