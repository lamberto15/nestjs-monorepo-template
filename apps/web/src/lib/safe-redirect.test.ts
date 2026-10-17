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
    'evil.example',
    '',
  ])('refuses an open redirect: %s', (value) => {
    expect(isSafeRedirect(value)).toBe(false);
    expect(safeRedirect(value)).toBe('/');
  });

  it('drops an unsafe ?redirect= from the search', () => {
    expect(redirectSearchSchema.parse({ redirect: '//evil.example' })).toEqual({
      redirect: undefined,
    });
    expect(redirectSearchSchema.parse({ redirect: '/notes' })).toEqual({
      redirect: '/notes',
    });
  });
});
