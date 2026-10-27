import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStatus, fetchVersion, validSha } from './build-version';
const sha = 'a'.repeat(40);
afterEach(() => vi.unstubAllGlobals());
describe('build identity', () => {
  it('bypasses HTTP cache when comparing with deployed content', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sha }),
    }));
    vi.stubGlobal('fetch', mockFetch);
    await expect(fetchVersion('/version.json')).resolves.toBe(sha);
    expect(mockFetch).toHaveBeenCalledWith('/version.json', {
      cache: 'no-store',
    });
  });
  it('treats missing metadata as unknown, not current', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    await expect(fetchVersion('/health/version')).resolves.toBeUndefined();
  });
  it('validates commit identities', () => {
    expect(validSha({ sha })).toBe(sha);
    expect(validSha({ sha: 'latest' })).toBeUndefined();
    expect(validSha(null)).toBeUndefined();
  });
  it('does not confuse deployed with newest GitHub commit', () => {
    expect(buildStatus(sha, sha)).toBe('current');
    expect(buildStatus(sha, 'b'.repeat(40))).toBe('stale');
    expect(buildStatus(sha, undefined)).toBe('unknown');
    expect(buildStatus('', sha)).toBe('unknown');
  });
});
