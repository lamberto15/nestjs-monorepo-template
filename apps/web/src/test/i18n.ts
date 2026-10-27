import type { InitOptions } from 'i18next';

/**
 * The keys a test rendered that no English catalog has, from i18next's
 * documented hook for them (`saveMissing` with a `missingKeyHandler`):
 * setup.ts fails the test that rendered one. Recorded, not thrown: a throw
 * during render is caught by the route's error boundary, and the test would
 * only see a broken page. A lookup with a `defaultValue` is a deliberate
 * fallback (labels the API names: setting groups, consent kinds, a fixture's
 * subject), not a missing key.
 */
const missing = new Set<string>();

export const missingKeyOptions = {
  saveMissing: true,
  missingKeyHandler: (
    _languages,
    namespace,
    key,
    _fallback,
    _update,
    options,
  ) => {
    const fallback = Object.keys((options ?? {}) as object).some((name) =>
      name.startsWith('defaultValue'),
    );
    if (!fallback) {
      missing.add(`${namespace}:${key}`);
    }
  },
} satisfies InitOptions;

/** The missing keys recorded since the last call (setup.ts, after each test). */
export function takeMissingKeys(): string[] {
  const keys = [...missing];
  missing.clear();
  return keys;
}
