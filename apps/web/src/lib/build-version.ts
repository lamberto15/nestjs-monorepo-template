declare const __APP_GIT_SHA__: string;
export const loadedSha = __APP_GIT_SHA__;

export function validSha(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('sha' in value)) return undefined;
  const sha = value.sha;
  return typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
}

export function buildStatus(loaded?: string, served?: string) {
  if (!loaded || !served) return 'unknown' as const;
  return loaded === served ? 'current' as const : 'stale' as const;
}

export async function fetchVersion(url: string): Promise<string | undefined> {
  const response = await fetch(url, { cache: 'no-store' });
  return response.ok ? validSha(await response.json()) : undefined;
}
