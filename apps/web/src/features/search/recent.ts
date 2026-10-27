const prefix = 'recent-searches';
const max = 5;

/**
 * One list per session identity (`sessionIdentity`, lib/session.ts: the user,
 * the tenant, the impersonator): another account or tenant on this browser
 * never sees what was searched in this one. Null (nobody) keeps nothing.
 */
const keyOf = (identity: string) => `${prefix}:${identity}`;

/** The last searches of this session (localStorage may be missing or full). */
export function readRecent(identity: string | null): string[] {
  if (identity === null) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(keyOf(identity)) ?? '[]',
    );
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string').slice(0, max)
      : [];
  } catch {
    return [];
  }
}

export function addRecent(identity: string | null, query: string): string[] {
  const q = query.trim();
  if (!q || identity === null) {
    return readRecent(identity);
  }
  const next = [q, ...readRecent(identity).filter((v) => v !== q)].slice(
    0,
    max,
  );
  try {
    localStorage.setItem(keyOf(identity), JSON.stringify(next));
  } catch {
    // Not kept; the list still works for this session.
  }
  return next;
}

export function clearRecent(identity: string | null): void {
  if (identity === null) {
    return;
  }
  try {
    localStorage.removeItem(keyOf(identity));
  } catch {
    // Nothing to clear.
  }
}

/**
 * Every session's list, and the browser-wide one kept before them (the bare
 * `recent-searches` key): signing out leaves no searches behind (app.tsx
 * registers it with the session's resets).
 */
export function clearAllRecent(): void {
  try {
    const names: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index);
      if (name === prefix || name?.startsWith(`${prefix}:`)) {
        names.push(name);
      }
    }
    for (const name of names) {
      localStorage.removeItem(name);
    }
  } catch {
    // Nothing to clear.
  }
}
