const key = 'recent-searches';
const max = 5;

/** The last searches of this browser (localStorage may be missing or full). */
export function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string').slice(0, max)
      : [];
  } catch {
    return [];
  }
}

export function addRecent(query: string): string[] {
  const q = query.trim();
  if (!q) {
    return readRecent();
  }
  const next = [q, ...readRecent().filter((v) => v !== q)].slice(0, max);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Not kept; the list still works for this session.
  }
  return next;
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}
