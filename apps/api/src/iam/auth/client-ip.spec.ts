import { ipAllowed, normalizeCidr } from './client-ip.js';

describe('client IP allowlist', () => {
  it('normalizes CIDRs and bare addresses, and rejects the rest', () => {
    expect(normalizeCidr('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(normalizeCidr('203.0.113.9')).toBe('203.0.113.9/32');
    expect(normalizeCidr('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(normalizeCidr('2001:db8::1')).toBe('2001:db8::1/128');
    for (const bad of [
      '',
      'nope',
      '10.0.0.0/33',
      '::/129',
      '10.0.0.0/-1',
      '10.0.0.0/8/8',
      '10.0.0.0/x',
    ]) {
      expect(normalizeCidr(bad)).toHaveProperty('error');
    }
  });

  it('matches IPv4, IPv6 and IPv4-mapped IPv6 addresses', () => {
    const list = ['203.0.113.0/24', '2001:db8::/32'];
    expect(ipAllowed('203.0.113.9', list)).toBe(true);
    expect(ipAllowed('::ffff:203.0.113.9', list)).toBe(true);
    expect(ipAllowed('2001:db8::5', list)).toBe(true);
    expect(ipAllowed('198.51.100.1', list)).toBe(false);
    expect(ipAllowed('::ffff:198.51.100.1', list)).toBe(false);
    expect(ipAllowed('2001:db9::1', list)).toBe(false);
  });

  it('allows anyone with an empty list, and nobody without a readable address', () => {
    expect(ipAllowed('198.51.100.1', [])).toBe(true);
    expect(ipAllowed(undefined, [])).toBe(true);
    expect(ipAllowed(undefined, ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('not-an-ip', ['203.0.113.0/24'])).toBe(false);
  });
});
