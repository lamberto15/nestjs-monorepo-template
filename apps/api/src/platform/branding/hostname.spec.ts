import { requestHostname } from '../../iam/auth/host-tenant.js';
import { normalizeHostname } from './hostname.js';

describe('custom domain hostnames', () => {
  const APP = ['app.example.net', 'web.example.net'];
  const check = (input: string) => normalizeHostname(input, APP);

  it.each([
    ['App.Example.COM', 'app.example.com'],
    ['app.example.com.', 'app.example.com'],
    ['  app.example.com ', 'app.example.com'],
    ['bücher.example.de', 'xn--bcher-kva.example.de'],
    ['xn--bcher-kva.example.de', 'xn--bcher-kva.example.de'],
    ['a-b.c-d.example.co.uk', 'a-b.c-d.example.co.uk'],
    ['shop.xn--p1ai', 'shop.xn--p1ai'],
    // Another site that only ends like the app's domain.
    ['notapp.example.net', 'notapp.example.net'],
  ])('takes %s as %s', (input, hostname) => {
    expect(check(input)).toEqual({ hostname });
  });

  it.each([
    ['', 'not_a_hostname'],
    ['10.0.0.1', 'ip_address'],
    ['[::1]', 'ip_address'],
    ['::ffff:127.0.0.1', 'ip_address'],
    ['0x7f.1', 'ip_address'],
    ['１２７.０.０.１', 'ip_address'],
    ['app.example.com:443', 'port'],
    ['app.example.com:', 'port'],
    ['http://app.example.com', 'not_a_hostname'],
    ['app.example.com/x', 'not_a_hostname'],
    ['app.example.com?x', 'not_a_hostname'],
    ['a b.example.com', 'not_a_hostname'],
    ['*.example.com', 'not_a_hostname'],
    ['app..example.com', 'not_a_hostname'],
    ['app_1.example.com', 'not_a_hostname'],
    ['example', 'not_a_hostname'],
    ['app.example.c0m', 'not_a_hostname'],
    [
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
      'not_a_hostname',
    ],
    ['nas.local', 'reserved'],
    ['x.localhost', 'reserved'],
    ['x.onion', 'reserved'],
    ['1.0.0.127.in-addr.arpa', 'reserved'],
    ['app.example.net', 'app_domain'],
    ['APP.example.net.', 'app_domain'],
    ['t1.web.example.net', 'app_domain'],
  ])('refuses %j (%s)', (input, refused) => {
    expect(check(input)).toEqual({ refused });
  });

  it.each([
    ['App.Example.com:8443', 'app.example.com'],
    ['app.example.com.', 'app.example.com'],
    ['[::1]:3000', '[::1]'],
    ['127.0.0.1', '127.0.0.1'],
    [undefined, undefined],
    ['', undefined],
  ])('reads the Host %j as %j', (host, hostname) => {
    expect(requestHostname(host)).toBe(hostname);
  });
});
