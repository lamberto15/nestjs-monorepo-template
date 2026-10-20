import {
  addressAllowed,
  safeFetch,
  UnsafeDestinationError,
} from './safe-fetch.js';

describe('safeFetch', () => {
  it.each([
    ['169.254.169.254', false],
    ['168.63.129.16', false],
    ['224.0.0.1', false],
    ['fe80::1', false],
    ['fd00:ec2::254', false],
    ['2001:db8::1', false],
    ['::ffff:169.254.169.254', false],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['192.168.1.1', false],
    ['100.64.0.1', false],
    ['::1', false],
    ['fc00::1', false],
    ['0.0.0.0', false],
    ['::ffff:127.0.0.1', false],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['not-an-address', false],
  ])('judges %s: %s', (address, allowed) => {
    expect(addressAllowed(address)).toBe(allowed);
  });

  it('lets loopback and private ranges through only when asked, never link-local', () => {
    expect(addressAllowed('127.0.0.1', true)).toBe(true);
    expect(addressAllowed('10.0.0.1', true)).toBe(true);
    expect(addressAllowed('169.254.169.254', true)).toBe(false);
    expect(addressAllowed('fe80::1', true)).toBe(false);
  });

  it('refuses http, credentials in the URL and refused IP literals before connecting', async () => {
    const fetch = safeFetch({ timeoutMs: 1000, maxBytes: 1024 });
    await expect(fetch('http://example.com/')).rejects.toBeInstanceOf(
      UnsafeDestinationError,
    );
    await expect(fetch('https://user:pw@example.com/')).rejects.toBeInstanceOf(
      UnsafeDestinationError,
    );
    await expect(
      fetch('https://169.254.169.254/latest/meta-data'),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
    await expect(fetch('https://[::1]/')).rejects.toBeInstanceOf(
      UnsafeDestinationError,
    );
  });
});
