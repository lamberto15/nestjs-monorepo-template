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
    // Vitest 5 persists transformed modules on disk but skips a module only
    // when it contains the text `import.meta.glob(`. Ours are typed
    // (`glob<T>(`), so a glob result went stale when files were added or
    // removed (the nav and i18n globs). Off until Vitest handles that.
    fsModuleCache: false,
  },
});
