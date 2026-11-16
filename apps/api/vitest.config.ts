import { defineConfig } from 'vitest/config';
import { coverage } from './vitest.coverage.js';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library` (built into Vite 8: no plugin).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Coverage runs only with --coverage (CI's unit step; `pnpm test:cov`).
    // These thresholds gate the unit tests alone; the gate that counts is the
    // merged one, unit and e2e together (vitest.config.merge.ts). They sit at
    // the measured levels (docs/development.md, "Coverage"): raise them when
    // a change lifts the numbers, never lower.
    coverage: {
      ...coverage,
      thresholds: { statements: 30, branches: 27, functions: 26, lines: 30 },
    },
  },
});
