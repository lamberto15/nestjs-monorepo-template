import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library` (built into Vite 8: no plugin).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Coverage runs only with --coverage (CI's unit shards; `pnpm test:cov`).
    // The thresholds sit at the measured levels (docs/development.md,
    // "Coverage"): raise them when a change lifts the numbers, never lower.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { statements: 30, branches: 27, functions: 26, lines: 30 },
    },
  },
});
