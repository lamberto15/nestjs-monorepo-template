import {
  addWorkingMinutes,
  type CalendarDefinition,
  minuteOf,
  NoWorkingTimeError,
  spansProblem,
  zonedMoment,
} from './calendar-time.js';

const weekdays = (start: string, end: string) =>
  [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start, end }));

const office = (timezone: string): CalendarDefinition => ({
  timezone,
  hours: weekdays('09:00', '17:00'),
  exceptions: [],
});

const at = (definition: CalendarDefinition, from: string, minutes: number) =>
  addWorkingMinutes(definition, new Date(from), minutes).toISOString();

describe('addWorkingMinutes', () => {
  it('counts only working time: a Friday afternoon runs into Monday', () => {
    // Fri 2026-10-23 16:00Z + 2 h: one hour Friday, one hour Monday.
    expect(at(office('UTC'), '2026-10-23T16:00:00Z', 120)).toBe(
      '2026-10-26T10:00:00.000Z',
    );
  });

  it('waits for the next span from a weekend or before opening; 0 minutes is the first working moment', () => {
    const calendar = office('UTC');
    expect(at(calendar, '2026-10-24T12:00:00Z', 30)).toBe(
      '2026-10-26T09:30:00.000Z',
    );
    expect(at(calendar, '2026-10-26T06:00:00Z', 0)).toBe(
      '2026-10-26T09:00:00.000Z',
    );
    expect(at(calendar, '2026-10-26T10:15:00Z', 0)).toBe(
      '2026-10-26T10:15:00.000Z',
    );
  });

  it('skips a closed exception and follows special hours', () => {
    const calendar: CalendarDefinition = {
      ...office('UTC'),
      exceptions: [
        { date: '2026-10-26', name: 'Closed' },
        {
          date: '2026-10-27',
          name: 'Half day',
          hours: [{ start: '09:00', end: '10:00' }],
        },
      ],
    };
    // Monday is closed; Tuesday gives one hour, Wednesday the rest.
    expect(at(calendar, '2026-10-23T16:30:00Z', 150)).toBe(
      '2026-10-28T10:00:00.000Z',
    );
  });

  it('keeps the wall clock across the spring-forward change (New York)', () => {
    // Fri 2026-03-06 16:00 EST (21:00Z) + 2 h: Monday 2026-03-09 is EDT.
    expect(at(office('America/New_York'), '2026-03-06T21:00:00Z', 120)).toBe(
      '2026-03-09T14:00:00.000Z',
    );
  });

  it('keeps the wall clock across the fall-back change (Berlin)', () => {
    // Fri 2026-10-23 16:00 CEST (14:00Z) + 2 h: Monday 2026-10-26 is CET (10:00 = 09:00Z).
    expect(at(office('Europe/Berlin'), '2026-10-23T14:00:00Z', 120)).toBe(
      '2026-10-26T09:00:00.000Z',
    );
  });

  it('counts the real time of a span a change cuts short (spring forward)', () => {
    const night: CalendarDefinition = {
      timezone: 'America/New_York',
      hours: [{ weekday: 0, start: '00:00', end: '08:00' }],
      exceptions: [],
    };
    // Sun 2026-03-08 00:00 EST: the clock skips 02:00-03:00, so 7 h pass by 08:00 EDT.
    expect(at(night, '2026-03-08T05:00:00Z', 420)).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    // One more minute does not fit: it waits for the next Sunday.
    expect(at(night, '2026-03-08T05:00:00Z', 421)).toBe(
      '2026-03-15T04:01:00.000Z',
    );
  });

  it('counts the real time of a span a change stretches (fall back)', () => {
    const night: CalendarDefinition = {
      timezone: 'America/New_York',
      hours: [{ weekday: 0, start: '00:00', end: '08:00' }],
      exceptions: [],
    };
    // Sun 2026-11-01 00:00 EDT: 01:00-02:00 happens twice, so 9 h pass by 08:00 EST.
    expect(at(night, '2026-11-01T04:00:00Z', 540)).toBe(
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('fails for a calendar with no working time instead of looping', () => {
    expect(() =>
      addWorkingMinutes(
        { timezone: 'UTC', hours: [], exceptions: [] },
        new Date('2026-10-23T16:00:00Z'),
        10,
      ),
    ).toThrow(NoWorkingTimeError);
  });
});

describe('zonedMoment', () => {
  it('moves a time the clock skips to the moment after the gap', () => {
    // 02:30 on 2026-03-08 does not exist in New York: 03:30 EDT.
    expect(
      new Date(
        zonedMoment('2026-03-08', 150, 'America/New_York'),
      ).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });

  it('takes the first of a time the clock repeats', () => {
    // 01:30 on 2026-11-01 happens twice: the EDT one.
    expect(
      new Date(zonedMoment('2026-11-01', 90, 'America/New_York')).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  it('reads 24:00 as the next midnight', () => {
    expect(new Date(zonedMoment('2026-10-23', 1440, 'UTC')).toISOString()).toBe(
      '2026-10-24T00:00:00.000Z',
    );
  });
});

describe('spans', () => {
  it('reads clock times', () => {
    expect(minuteOf('09:30')).toBe(570);
    expect(minuteOf('24:00')).toBe(1440);
    expect(minuteOf('24:01')).toBeNaN();
    expect(minuteOf('9:30')).toBeNaN();
  });

  it('refuses bad, empty and overlapping spans', () => {
    expect(spansProblem([{ start: '09:00', end: '17:00' }])).toBeNull();
    expect(spansProblem([{ start: '17:00', end: '09:00' }])).toMatch(/ends/);
    expect(spansProblem([{ start: '9am', end: '17:00' }])).toMatch(/HH:MM/);
    expect(
      spansProblem([
        { start: '09:00', end: '13:00' },
        { start: '12:00', end: '17:00' },
      ]),
    ).toMatch(/overlap/);
  });
});
