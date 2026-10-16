import { nextRunTime } from './report-time.js';

describe('nextRunTime', () => {
  it("is today's hour when it is still ahead, else tomorrow's (daily)", () => {
    // 07:00 in Manila (+08:00): 08:00 Manila is 00:00Z.
    expect(
      nextRunTime(
        { every: 'daily', hour: 8 },
        new Date('2026-10-15T23:00:00Z'),
        'Asia/Manila',
      ),
    ).toEqual(new Date('2026-10-16T00:00:00Z'));
    // Exactly 08:00: strictly after, so tomorrow's.
    expect(
      nextRunTime(
        { every: 'daily', hour: 8 },
        new Date('2026-10-16T00:00:00Z'),
        'Asia/Manila',
      ),
    ).toEqual(new Date('2026-10-17T00:00:00Z'));
  });

  it('handles hour 0', () => {
    // 23:30 in Kolkata (+05:30) on the 16th: midnight is 18:30Z.
    expect(
      nextRunTime(
        { every: 'daily', hour: 0 },
        new Date('2026-10-16T18:00:00Z'),
        'Asia/Kolkata',
      ),
    ).toEqual(new Date('2026-10-16T18:30:00Z'));
    expect(
      nextRunTime(
        { every: 'daily', hour: 0 },
        new Date('2026-10-16T00:00:00Z'),
        'UTC',
      ),
    ).toEqual(new Date('2026-10-17T00:00:00Z'));
  });

  it('follows the clock across a daylight-saving change', () => {
    // New York leaves DST on 2026-11-01: 08:00 that day is 13:00Z (EST).
    expect(
      nextRunTime(
        { every: 'daily', hour: 8 },
        new Date('2026-10-31T23:00:00Z'),
        'America/New_York',
      ),
    ).toEqual(new Date('2026-11-01T13:00:00Z'));
    // Entering DST on 2027-03-14, 02:00 is skipped: moved to 03:00 EDT (07:00Z).
    expect(
      nextRunTime(
        { every: 'daily', hour: 2 },
        new Date('2027-03-14T05:00:00Z'),
        'America/New_York',
      ),
    ).toEqual(new Date('2027-03-14T07:00:00Z'));
  });

  it("wraps a weekly schedule into next week once this week's passed", () => {
    // 2026-10-16 is a Friday. Monday 09:00 Berlin (CEST until the 25th, CET after).
    expect(
      nextRunTime(
        { every: 'weekly', weekday: 1, hour: 9 },
        new Date('2026-10-16T10:00:00Z'),
        'Europe/Berlin',
      ),
    ).toEqual(new Date('2026-10-19T07:00:00Z'));
    // Friday 09:00 has passed at 12:00 Berlin: next Friday, in CET by then.
    expect(
      nextRunTime(
        { every: 'weekly', weekday: 5, hour: 9 },
        new Date('2026-10-23T10:00:00Z'),
        'Europe/Berlin',
      ),
    ).toEqual(new Date('2026-10-30T08:00:00Z'));
    // Sunday (0), from a Saturday night across the year's end.
    expect(
      nextRunTime(
        { every: 'weekly', weekday: 0, hour: 6 },
        new Date('2026-12-26T23:00:00Z'),
        'UTC',
      ),
    ).toEqual(new Date('2026-12-27T06:00:00Z'));
  });

  it('runs a monthly schedule on its day, past month ends', () => {
    // The 28th of February, from the 28th of January after the hour.
    expect(
      nextRunTime(
        { every: 'monthly', day: 28, hour: 23 },
        new Date('2027-01-28T23:30:00Z'),
        'UTC',
      ),
    ).toEqual(new Date('2027-02-28T23:00:00Z'));
    // From the 31st of a month to the 1st of the next, and the year.
    expect(
      nextRunTime(
        { every: 'monthly', day: 1, hour: 0 },
        new Date('2026-12-31T12:00:00Z'),
        'Asia/Tokyo',
      ),
    ).toEqual(new Date('2026-12-31T15:00:00Z'));
  });
});
