import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage.js';

// The gate on the API's coverage: `vitest --merge-reports --coverage` over the
// blobs of the unit run and of every e2e shard (docs/development.md,
// "Coverage"). It runs no test, so it needs none of the e2e setup. The
// thresholds sit a little below the merged figures measured on 2026-11-17
// (statements 91.69%, branches 81.65%, functions 93.12%, lines 92.25%: the
// unit run and the whole e2e suite, one e2e test failing on a timestamp tie),
// one whole percent under the rounded-down figures for run-to-run noise: raise
// them when a change lifts the numbers, never lower.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    coverage: {
      ...coverage,
      thresholds: { statements: 90, branches: 80, functions: 92, lines: 91 },
    },
  },
});
