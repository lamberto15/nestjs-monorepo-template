import { deviceLabel, deviceOf } from './devices.js';

const chrome = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

describe('deviceOf', () => {
  it('is the same device after a browser update, from the same address', () => {
    const before = deviceOf(chrome('130.0.0.0'), '::ffff:10.0.0.1');
    const after = deviceOf(chrome('131.0.6778.86'), '10.0.0.1');
    expect(after.hash).toBe(before.hash);
    expect(after).toMatchObject({ summary: 'Chrome on macOS', ip: '10.0.0.1' });
  });

  it('is another device with another browser or address', () => {
    const hash = deviceOf(chrome('130.0.0.0'), '10.0.0.1').hash;
    expect(deviceOf(chrome('130.0.0.0'), '10.0.0.2').hash).not.toBe(hash);
    const firefox =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0';
    expect(deviceOf(firefox, '10.0.0.1')).toMatchObject({
      summary: 'Firefox on macOS',
    });
    expect(deviceOf(firefox, '10.0.0.1').hash).not.toBe(hash);
  });

  it('counts an IPv6 address by its /64: privacy extensions change the rest daily', () => {
    const agent = chrome('130.0.0.0');
    const today = deviceOf(agent, '2001:db8:aa:1:1c2f:9e1:3b2:44d1');
    const tomorrow = deviceOf(agent, '2001:0db8:00aa:0001::7');
    expect(tomorrow.hash).toBe(today.hash);
    // The full address is kept, for people.
    expect(today.ip).toBe('2001:db8:aa:1:1c2f:9e1:3b2:44d1');
    expect(deviceOf(agent, '2001:db8:aa:2::7').hash).not.toBe(today.hash);
    expect(deviceOf(agent, '::1').hash).not.toBe(today.hash);
  });

  it('summarizes what it recognizes, and names the rest by its first product', () => {
    const summary = (agent: unknown) => deviceOf(agent, '10.0.0.1').summary;
    expect(
      summary(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(
      summary(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      ),
    ).toBe('Edge on Windows');
    expect(summary('curl/8.7.1')).toBe('curl');
    expect(summary(undefined)).toBe('unknown');
  });

  it('names an app by its product token on its system, a web view by its system', () => {
    const summary = (agent: unknown) => deviceOf(agent, '10.0.0.1').summary;
    expect(summary('NestJSMobile/1.0.0 (iPhone 17 Pro; iOS 26.5)')).toBe(
      'NestJSMobile on iOS',
    );
    expect(summary('NestJSMobile/1.0.0 (Pixel 9; Android 16)')).toBe(
      'NestJSMobile on Android',
    );
    expect(
      summary(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      ),
    ).toBe('iOS');
  });
});

describe('deviceLabel', () => {
  it('is the readable summary of a user agent, null when there is none', () => {
    expect(deviceLabel(chrome('131.0.0.0'))).toBe('Chrome on macOS');
    expect(deviceLabel('curl/8.7.1')).toBe('curl');
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel('')).toBeNull();
  });
});
