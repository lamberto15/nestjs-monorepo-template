import { isCrossOriginCeremony } from './passkeys.service.js';

describe('isCrossOriginCeremony', () => {
  it('accepts a ceremony run on the page itself', () => {
    expect(isCrossOriginCeremony({ crossOrigin: false })).toBe(false);
    // Older browsers leave the member out.
    expect(isCrossOriginCeremony({})).toBe(false);
  });

  it('refuses one run in a frame of another origin, with or without a top origin', () => {
    expect(isCrossOriginCeremony({ crossOrigin: true })).toBe(true);
    expect(
      isCrossOriginCeremony({
        crossOrigin: true,
        topOrigin: 'https://evil.example',
      }),
    ).toBe(true);
  });

  it('refuses a top origin without crossOrigin (a browser bug, never trusted)', () => {
    expect(
      isCrossOriginCeremony({
        crossOrigin: false,
        topOrigin: 'https://web.example.com',
      }),
    ).toBe(true);
  });
});
