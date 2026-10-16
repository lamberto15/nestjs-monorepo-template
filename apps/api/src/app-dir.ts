import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The app's own directory: `apps/api` in the repository, `/app` in the image.
 * This file is `src/app-dir.ts` or `dist/app-dir.js`, so the parent works from
 * both. Files the app keeps for itself (`.env.development`, `.data/`) resolve
 * against it, not against the shell's directory: `pnpm start:dev` from the
 * repository root runs here, `node apps/api/dist/main` from anywhere too.
 */
export const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** `path` against the app's directory (an absolute one stays as it is). */
export const appPath = (path: string) => resolve(APP_DIR, path);
