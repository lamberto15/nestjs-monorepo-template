import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Coverage runs only with --coverage (CI's packages job). The thresholds
    // sit at the measured levels (docs/development.md, "Coverage").
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // schema.ts is generated (openapi-typescript): nothing to test.
      exclude: ['src/**/*.spec.ts', 'src/schema.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { statements: 67, branches: 77, functions: 47, lines: 68 },
    },
  },
});
