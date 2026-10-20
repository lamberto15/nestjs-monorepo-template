import { bindingHash, newBinding, ssoCookie } from './sso-browser.js';

describe('the SSO browser binding', () => {
  it('is a __Host- cookie, SameSite=None, when Secure', () => {
    const cookie = ssoCookie(true);
    const binding = newBinding();
    expect(cookie.set(binding)).toBe(
      `__Host-sso_tx=${binding}; Path=/; HttpOnly; Max-Age=600; SameSite=None; Secure`,
    );
    expect(cookie.read(`a=b; __Host-sso_tx=${binding}`)).toBe(binding);
  });

  it('reads only a well-formed binding of its own name', () => {
    const cookie = ssoCookie(false);
    const binding = newBinding();
    expect(cookie.read(`sso_tx=${binding}`)).toBe(binding);
    expect(cookie.read(`__Host-sso_tx=${binding}`)).toBeUndefined();
    expect(cookie.read('sso_tx=short')).toBeUndefined();
    expect(cookie.read(undefined)).toBeUndefined();
  });

  it('keeps only the SHA-256 of a binding', () => {
    const binding = newBinding();
    expect(bindingHash(binding)).not.toContain(binding);
    expect(bindingHash(binding)).toBe(bindingHash(binding));
    expect(bindingHash(binding)).not.toBe(bindingHash(newBinding()));
  });
});
