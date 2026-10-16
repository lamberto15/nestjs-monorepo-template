import { nextDigestTime } from './digest-time.js';

describe('nextDigestTime', () => {
  it('is now for an hourly digest', () => {
    const now = new Date('2026-10-16T09:17:00Z');
    expect(nextDigestTime('hourly', now, 'Asia/Dubai', 8)).toEqual(now);
  });

  it("is today's hour when it is still ahead, in the recipient's zone", () => {
    // 05:17 in Dubai (+04:00): 08:00 Dubai is 04:00Z.
    const now = new Date('2026-10-16T01:17:00Z');
    expect(nextDigestTime('daily', now, 'Asia/Dubai', 8)).toEqual(
      new Date('2026-10-16T04:00:00Z'),
    );
  });

  it("is tomorrow's hour once today's has passed", () => {
    // 09:17 in Dubai: 08:00 passed; tomorrow 08:00 Dubai is 04:00Z.
    const now = new Date('2026-10-16T05:17:00Z');
    expect(nextDigestTime('daily', now, 'Asia/Dubai', 8)).toEqual(
      new Date('2026-10-17T04:00:00Z'),
    );
  });

  it('handles a half-hour zone and hour 0', () => {
    // 23:30 in Kolkata (+05:30) on the 16th: midnight is 18:30Z.
    const now = new Date('2026-10-16T18:00:00Z');
    expect(nextDigestTime('daily', now, 'Asia/Kolkata', 0)).toEqual(
      new Date('2026-10-16T18:30:00Z'),
    );
  });

  it('follows the clock across a daylight-saving change', () => {
    // New York leaves DST on 2026-11-01 at 02:00 (clocks go back to 01:00).
    // The evening before, 08:00 on the 1st is 13:00Z (EST), not 12:00Z (EDT).
    const now = new Date('2026-10-31T23:00:00Z');
    expect(nextDigestTime('daily', now, 'America/New_York', 8)).toEqual(
      new Date('2026-11-01T13:00:00Z'),
    );
    // Entering DST on 2027-03-14: 02:00 is skipped; 08:00 is 12:00Z (EDT).
    const march = new Date('2027-03-13T23:00:00Z');
    expect(nextDigestTime('daily', march, 'America/New_York', 8)).toEqual(
      new Date('2027-03-14T12:00:00Z'),
    );
    // An hour the clock skips (02:00 on 2027-03-14): the first moment after it.
    expect(nextDigestTime('daily', march, 'America/New_York', 2)).toEqual(
      new Date('2027-03-14T07:00:00Z'),
    );
  });
});
