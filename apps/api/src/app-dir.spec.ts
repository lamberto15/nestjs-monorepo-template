import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { coreEnv } from './core/config/core.env.js';
import { platformEnv } from './platform/platform.env.js';
import { APP_DIR, appPath } from './app-dir.js';
import { DEV_ENV_FILE } from './dev-env.js';

/** The app's files resolve against apps/api, whatever the shell's directory. */
describe('the app directory', () => {
  // This file is apps/api/src/app-dir.spec.ts.
  const packageDir = resolve(import.meta.dirname, '..');

  it('is the API package (apps/api), not the working directory', () => {
    expect(APP_DIR).toBe(packageDir);
    const manifest = JSON.parse(
      readFileSync(join(APP_DIR, 'package.json'), 'utf8'),
    ) as { name: string };
    expect(manifest.name).toBe('@nestjs-monorepo-template/api');
  });

  it('holds .env.development', () => {
    expect(DEV_ENV_FILE).toBe(join(packageDir, '.env.development'));
  });

  it('holds the local files and mails by default; an absolute path stays', () => {
    const core = coreEnv.pick({ MAIL_DIRECTORY: true });
    const platform = platformEnv.pick({ STORAGE_ROOT: true });
    expect(core.parse({}).MAIL_DIRECTORY).toBe(join(packageDir, '.data/mail'));
    expect(platform.parse({ STORAGE_ROOT: '' }).STORAGE_ROOT).toBe(
      join(packageDir, '.data/storage'),
    );
    expect(platform.parse({ STORAGE_ROOT: 'files' }).STORAGE_ROOT).toBe(
      join(packageDir, 'files'),
    );
    expect(platform.parse({ STORAGE_ROOT: '/srv/files' }).STORAGE_ROOT).toBe(
      '/srv/files',
    );
    expect(appPath('/app/.data/storage')).toBe('/app/.data/storage');
  });
});
