import { isNativeRedirectUri } from './native-redirect.js';

describe('isNativeRedirectUri', () => {
  it('takes a reverse-DNS private-use scheme or an https link (RFC 8252)', () => {
    expect(isNativeRedirectUri('com.example.app:/auth')).toBe(true);
    expect(isNativeRedirectUri('https://app.example.com/auth/native')).toBe(
      true,
    );
  });

  it('refuses a scheme a browser runs, plain http, a fragment, no URI', () => {
    for (const uri of [
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,x',
      'http://app.example.com/auth',
      'myapp:/auth',
      'com.example.app:/auth#x',
      'not a uri',
    ]) {
      expect(isNativeRedirectUri(uri)).toBe(false);
    }
  });
});
