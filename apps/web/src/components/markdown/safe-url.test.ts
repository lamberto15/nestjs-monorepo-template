import { describe, expect, it } from 'vitest';
import { isSafeUrl } from './safe-url';

describe('isSafeUrl', () => {
  it.each([
    'https://example.com/a?b=c',
    'http://example.com',
    'mailto:ada@example.com',
    'HTTPS://EXAMPLE.COM',
  ])('allows %s', (url) => expect(isSafeUrl(url)).toBe(true));

  it.each([
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,AAAA',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    '/notes/other',
    'https://example.com/a b',
    '',
  ])('refuses %j', (url) => expect(isSafeUrl(url)).toBe(false));

  it('refuses a missing address', () => {
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
  });
});
