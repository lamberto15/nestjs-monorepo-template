import {
  REDIRECT_PATH_MAX_LENGTH,
  isSafeRedirectPath,
  redirectPath,
  webAppUrl,
} from './redirect-path.js';

const WEB = 'https://web.example.com';

/** Every spelling of "another site" a URL parser or a once-decoding client accepts. */
const offSite = [
  '//evil.example',
  '//evil.example/x',
  '/\\evil.example',
  '\\\\evil.example',
  '\\/evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  '/x\n',
  '/x\r',
  '/x\u0000',
  '/x\u007f',
  ' /x',
  '/x ',
  '/　/x',
  '/é',
  '/%09/evil.example',
  '/%0A/evil.example',
  '/%0d/evil.example',
  '/%5Cevil.example',
  '/%5cevil.example',
  '/%2Fevil.example',
  '/%2f%2fevil.example',
  '/.//evil.example',
  '/a/..//evil.example',
  'https://evil.example',
  'http:/evil.example',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,x',
  'evil.example',
  '',
  '/'.padEnd(REDIRECT_PATH_MAX_LENGTH + 1, 'a'),
];

describe('redirect paths', () => {
  it('accepts paths of the web app, with a query and a fragment', () => {
    for (const path of [
      '/',
      '/a/b?x=1#h',
      '/inbox',
      '/orders?x=1&y=%C3%BC',
      '/search?q=a%20b',
      '/a/../b',
      '/'.padEnd(REDIRECT_PATH_MAX_LENGTH, 'a'),
    ]) {
      expect(isSafeRedirectPath(path), path).toBe(true);
      expect(redirectPath.safeParse(path).success, path).toBe(true);
    }
  });

  it('refuses anything that could leave the web app', () => {
    for (const value of offSite) {
      expect(isSafeRedirectPath(value), JSON.stringify(value)).toBe(false);
      expect(redirectPath.safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
    // One problem per refused value, whichever rule it breaks first.
    for (const value of ['/\\x', '/.//x', 'x', `/${'a'.repeat(3000)}`]) {
      expect(redirectPath.safeParse(value).error?.issues, value).toHaveLength(
        1,
      );
    }
    for (const value of [undefined, null, 1, ['/a'], { a: '/a' }]) {
      expect(isSafeRedirectPath(value)).toBe(false);
    }
  });

  it("resolves a safe path on the web app's origin, anything else to its root", () => {
    expect(webAppUrl('/a/b?x=1#h', WEB).toString()).toBe(
      'https://web.example.com/a/b?x=1#h',
    );
    expect(webAppUrl('/a', `${WEB}/`).toString()).toBe(
      'https://web.example.com/a',
    );
    // The package's `redirectAfterLogin`: an absolute URL of the web app.
    expect(webAppUrl(`${WEB}/`, WEB).toString()).toBe(
      'https://web.example.com/',
    );
    expect(webAppUrl(`${WEB}/settings?x=1`, WEB).toString()).toBe(
      'https://web.example.com/settings?x=1',
    );
    for (const value of [
      ...offSite,
      undefined,
      'https://web.example.com.evil.example/',
      'https://web.example.com:8443/',
      'http://web.example.com/',
      'https://web.example.com//evil.example',
      'not a url',
    ]) {
      expect(webAppUrl(value, WEB).toString(), JSON.stringify(value)).toBe(
        'https://web.example.com/',
      );
    }
  });
});
