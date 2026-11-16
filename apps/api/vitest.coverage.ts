// The coverage settings the API's three Vitest configs share: the unit run
// (vitest.config.ts), the e2e run (vitest.config.e2e.ts) and the merge of both
// (vitest.config.merge.ts). Each adds its own thresholds, if any.
export const coverage = {
  provider: 'v8' as const,
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
  reporter: ['text-summary', 'json-summary'],
};
