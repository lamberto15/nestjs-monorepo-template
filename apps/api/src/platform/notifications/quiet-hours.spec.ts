import { quietUntil } from './quiet-hours.js';

const overnight = { start: '22:00', end: '07:00' };

describe('quietUntil', () => {
  it('is null outside the window, and without one', () => {
    const noon = new Date('2026-06-10T12:00:00Z');
    expect(quietUntil(noon, overnight, 'UTC')).toBeNull();
    expect(quietUntil(noon, null, 'UTC')).toBeNull();
    expect(quietUntil(noon, undefined, 'UTC')).toBeNull();
    expect(
      quietUntil(noon, { start: '08:00', end: '08:00' }, 'UTC'),
    ).toBeNull();
  });

  it('ends this evening’s window tomorrow morning', () => {
    expect(
      quietUntil(new Date('2026-06-10T23:30:00Z'), overnight, 'UTC'),
    ).toEqual(new Date('2026-06-11T07:00:00Z'));
  });

  it('ends this morning’s window this morning', () => {
    expect(
      quietUntil(new Date('2026-06-11T03:15:00Z'), overnight, 'UTC'),
    ).toEqual(new Date('2026-06-11T07:00:00Z'));
  });

  it('includes the start and excludes the end', () => {
    expect(
      quietUntil(new Date('2026-06-10T22:00:00Z'), overnight, 'UTC'),
    ).not.toBeNull();
    expect(
      quietUntil(new Date('2026-06-11T07:00:00Z'), overnight, 'UTC'),
    ).toBeNull();
  });

  it('handles a window within one day, with minutes', () => {
    const lunch = { start: '12:00', end: '13:30' };
    expect(quietUntil(new Date('2026-06-10T12:45:00Z'), lunch, 'UTC')).toEqual(
      new Date('2026-06-10T13:30:00Z'),
    );
    expect(
      quietUntil(new Date('2026-06-10T13:30:00Z'), lunch, 'UTC'),
    ).toBeNull();
  });

  it('reads the clock of the time zone', () => {
    // 22:30 in Berlin (CEST, UTC+2) is 20:30 UTC.
    expect(
      quietUntil(new Date('2026-06-10T20:30:00Z'), overnight, 'Europe/Berlin'),
    ).toEqual(new Date('2026-06-11T05:00:00Z'));
    // The same instant is early evening in New York: not quiet.
    expect(
      quietUntil(
        new Date('2026-06-10T20:30:00Z'),
        overnight,
        'America/New_York',
      ),
    ).toBeNull();
    // Dubai has no daylight saving: 07:00 is 03:00 UTC, and 20:30 UTC is already past midnight there.
    expect(
      quietUntil(new Date('2026-06-10T10:00:00Z'), overnight, 'Asia/Dubai'),
    ).toBeNull();
    expect(
      quietUntil(new Date('2026-06-10T20:30:00Z'), overnight, 'Asia/Dubai'),
    ).toEqual(new Date('2026-06-11T03:00:00Z'));
    expect(
      quietUntil(new Date('2026-06-10T19:30:00Z'), overnight, 'Asia/Dubai'),
    ).toEqual(new Date('2026-06-11T03:00:00Z'));
  });

  it('follows a daylight-saving change', () => {
    // Berlin, night of 2026-03-28 to 29: clocks go forward at 02:00, so 07:00 is 05:00 UTC (CEST), not 06:00.
    expect(
      quietUntil(new Date('2026-03-28T23:30:00Z'), overnight, 'Europe/Berlin'),
    ).toEqual(new Date('2026-03-29T05:00:00Z'));
    // The evening before, 22:30 CET (UTC+1) is 21:30 UTC.
    expect(
      quietUntil(new Date('2026-03-28T21:30:00Z'), overnight, 'Europe/Berlin'),
    ).toEqual(new Date('2026-03-29T05:00:00Z'));
  });
});
