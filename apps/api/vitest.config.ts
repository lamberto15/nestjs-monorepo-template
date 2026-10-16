import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library` (built into Vite 8: no plugin).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
