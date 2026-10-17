import { describe, expect, it } from 'vitest';
import {
  isSafeRedirect,
  redirectSearchSchema,
  safeRedirect,
} from './safe-redirect';

describe('the redirect guard', () => {
  it.each(['/', '/notes', '/notes?page=2#top', '/account/profile'])(
    'keeps a path of this app: %s',
    (value) => expect(isSafeRedirect(value)).toBe(true),
  );

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/\t/evil.example',
    '/..//evil.example',
    '/%2e%2e//evil.example',
    '/%2f%2fevil.example',
    '/%5cevil.example',
    '/a/../..//evil.example',
    'evil.example',
    '',
  ])('refuses an open redirect: %s', (value) => {
    expect(isSafeRedirect(value)).toBe(false);
    expect(safeRedirect(value)).toBe('/');
  });

  it('returns the normalized path, not the raw input', () => {
    expect(safeRedirect('/a/../notes?page=2#top')).toBe('/notes?page=2#top');
    expect(safeRedirect('/./account/profile')).toBe('/account/profile');
  });

  it('drops an unsafe ?redirect= from the search', () => {
    expect(redirectSearchSchema.parse({ redirect: '//evil.example' })).toEqual({
      redirect: undefined,
    });
    expect(redirectSearchSchema.parse({ redirect: '/x/../notes' })).toEqual({
      redirect: '/notes',
    });
    expect(
      redirectSearchSchema.parse({ redirect: '/%2e%2e//evil.example' }),
    ).toEqual({ redirect: undefined });
  });
});
