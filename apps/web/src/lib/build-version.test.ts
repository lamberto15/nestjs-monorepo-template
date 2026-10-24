import { describe, expect, it } from 'vitest';
import { buildStatus, validSha } from './build-version';
const sha = 'a'.repeat(40);
describe('build identity', () => {
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
