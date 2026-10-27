import { defineConfig } from 'vitest/config';
import { SizeSequencer } from './test/size-sequencer.js';

export default defineConfig({
  // tsconfig.json's path aliases (`nest g library`), built into Vite 8.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // A throwaway Redis and PostgreSQL (Docker) for the run, the database
    // migrated once as a template; each file's environment (fresh secrets,
    // workers off), set before AppModule loads.
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Each test boots an app and hashes passwords; files run in parallel, so a
    // 4 s test can pass 5 s (Vitest's default) under load.
    testTimeout: 20_000,
    // Each file boots whole apps (beforeEach): slow when the machine is busy
    // (other suites, IDEs). Fewer files at once and a generous boot limit keep
    // the suite reliable instead of failing on timeouts under load.
    hookTimeout: 60_000,
    // Each app holds a pool of 10 test connections: CI's PostgreSQL allows
    // 100 (the local one 1000), so raise its max_connections before this.
    maxWorkers: 4,
    // CI's shards by file size, not count (test/size-sequencer.ts).
    sequence: { sequencer: SizeSequencer },
  },
});
