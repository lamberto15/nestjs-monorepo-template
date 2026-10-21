import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Coverage runs only with --coverage (CI's unit shards). The thresholds
    // sit at the measured levels (docs/development.md, "Coverage").
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/**/test/**',
        'src/**/*.d.ts',
        'src/routeTree.gen.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { statements: 82, branches: 72, functions: 84, lines: 83 },
    },
    // Vitest 5 persists transformed modules on disk but skips a module only
    // when it contains the text `import.meta.glob(`. Ours are typed
    // (`glob<T>(`), so a glob result went stale when files were added or
    // removed (the nav and i18n globs). Off until Vitest handles that.
    fsModuleCache: false,
    // Half the CPUs, not Vitest's default (all but one). `pnpm test` runs
    // every package's Vitest at once through Turborepo, each with its own
    // workers, and a jsdom test renders the whole app in a CPU-bound worker:
    // with the default, 3 runs on 8 CPUs ran 21 workers, the tests ran ~6×
    // slower and random ones hit their timeouts (#127). With half, the
    // same 3 runs finished sooner and the slowest test took 2 s, not 10. A
    // run alone is no slower: the last workers only add contention.
    // CI is the exception: its web job runs this package's Vitest alone
    // (`turbo run test --filter`), so all of its 4 CPUs go to the tests.
    maxWorkers: process.env.CI ? '100%' : '50%',
    // Headroom for a loaded machine (CI's 4 CPUs, agents running e2e
    // beside it): the slowest test takes ~1.7 s alone, so 5 s (the default)
    // left 3×. Paired with Testing Library's asyncUtilTimeout in
    // src/test/setup.ts.
    testTimeout: 15_000,
  },
});
