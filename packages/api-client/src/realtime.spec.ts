import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from './realtime.js';

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://api.example.com')).toBe(
      'https://api.example.com',
    );
    expect(trimTrailingSlashes('https://api.example.com/')).toBe(
      'https://api.example.com',
    );
    expect(trimTrailingSlashes('https://api.example.com/v1///')).toBe(
      'https://api.example.com/v1',
    );
    expect(trimTrailingSlashes('/')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('stays linear on a URL made of slashes', () => {
    const slashes = '/'.repeat(1_000_000);
    const started = performance.now();
    expect(trimTrailingSlashes(`https://api.example.com${slashes}`)).toBe(
      'https://api.example.com',
    );
    // The regex it replaces (/\/+$/) is quadratic here: seconds, not milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
