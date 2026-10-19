import { defineConfig, devices } from '@playwright/test';

// The built web app (`vite preview`, which proxies /v1 to the API as Caddy
// does in production) and the built API with its demo data, on one origin:
// the __Host-sid session cookie needs it (docs/development.md, "Browser tests").
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';

export default defineConfig({
  testDir: './test',
  // One browser, one worker: the tests share one database, and a note one
  // creates must not be counted by another's list.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The JSON report carries the axe findings attached to each test
  // (scripts/axe-summary.mjs lists them in the job summary).
  reporter: [
    [process.env.CI ? 'github' : 'list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/report.json' }],
  ],
  use: {
    baseURL,
    // The trace of a test that failed, kept with the HTML report.
    trace: 'retain-on-failure',
    locale: 'en-US',
  },
  projects: [
    // Signs in once per role; the others reuse the saved state (storageState)
    // since the API limits sign-ins to 5 per email per 15 minutes.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // The seed, then the API (scripts/api.mjs).
      command: 'node scripts/api.mjs',
      url: 'http://localhost:3300/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command:
        'pnpm --filter @nestjs-monorepo-template/web exec vite preview --port 4173 --strictPort',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_URL: 'http://localhost:3300' },
    },
  ],
});
