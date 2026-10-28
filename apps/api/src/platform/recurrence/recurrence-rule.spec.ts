import {
  nextOccurrence,
  parseRule,
  type RecurrenceSchedule,
  RuleError,
} from './recurrence-rule.js';

const schedule = (
  rrule: string,
  startDate: string,
  time = '09:00',
  timezone = 'UTC',
): RecurrenceSchedule => ({
  rule: parseRule(rrule),
  startDate,
  time,
  timezone,
});

/** The next `n` occurrences after `from`, as ISO strings. */
function upcoming(spec: RecurrenceSchedule, from: string, n: number) {
  const found: string[] = [];
  let after = new Date(from);
  while (found.length < n) {
    const next = nextOccurrence(spec, after);
    if (!next) break;
    found.push(next.toISOString());
    after = next;
  }
  return found;
}

describe('parseRule', () => {
  it('reads the supported subset', () => {
    expect(
      parseRule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;COUNT=10'),
    ).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      byDay: [1, 3],
      byMonthDay: null,
      count: 10,
      until: null,
    });
    expect(
      parseRule('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231'),
    ).toMatchObject({
      byMonthDay: 15,
      until: '2026-12-31',
    });
  });

  it.each([
    'FREQ=HOURLY',
    'INTERVAL=2',
    'FREQ=DAILY;BYDAY=MO',
    'FREQ=DAILY;BYSETPOS=1',
    'FREQ=DAILY;COUNT=5;UNTIL=20261231',
    'FREQ=DAILY;COUNT=1001',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;FREQ=WEEKLY',
    'FREQ=WEEKLY;BYDAY=1MO',
    'FREQ=MONTHLY;BYMONTHDAY=32',
  ])('refuses %s', (rule) => {
    expect(() => parseRule(rule)).toThrow(RuleError);
  });
});

describe('nextOccurrence', () => {
  it('repeats every n days from the start date, not before it', () => {
    expect(
      upcoming(
        schedule('FREQ=DAILY;INTERVAL=3', '2026-11-02'),
        '2026-10-28T00:00:00Z',
        3,
      ),
    ).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-05T09:00:00.000Z',
      '2026-11-08T09:00:00.000Z',
    ]);
  });

  it('is strictly after the moment it is given', () => {
    const spec = schedule('FREQ=DAILY', '2026-11-02');
    expect(
      nextOccurrence(spec, new Date('2026-11-02T09:00:00Z'))?.toISOString(),
    ).toBe('2026-11-03T09:00:00.000Z');
  });

  it('weekly: the listed weekdays, every other week', () => {
    // 2026-11-02 is a Monday; weeks of Nov 2 and Nov 16 only.
    expect(
      upcoming(
        schedule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR', '2026-11-02'),
        '2026-11-02T10:00:00Z',
        3,
      ),
    ).toEqual([
      '2026-11-06T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
      '2026-11-20T09:00:00.000Z',
    ]);
  });

  it('monthly: a month without the day has no occurrence', () => {
    expect(
      upcoming(
        schedule('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-01'),
        '2026-01-31T10:00:00Z',
        3,
      ),
    ).toEqual([
      '2026-03-31T09:00:00.000Z',
      '2026-05-31T09:00:00.000Z',
      '2026-07-31T09:00:00.000Z',
    ]);
  });

  it('yearly: a 29 February waits for the next leap year', () => {
    expect(
      upcoming(
        schedule('FREQ=YEARLY', '2024-02-29'),
        '2024-03-01T00:00:00Z',
        1,
      ),
    ).toEqual(['2028-02-29T09:00:00.000Z']);
  });

  it('stops after UNTIL', () => {
    const spec = schedule('FREQ=DAILY;UNTIL=20261103', '2026-11-02');
    expect(upcoming(spec, '2026-11-01T00:00:00Z', 5)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ]);
  });

  it('keeps the wall clock across a daylight-saving change (New York)', () => {
    // 08:30 local: EST before 2026-11-01, EDT... the other way round after.
    expect(
      upcoming(
        schedule('FREQ=DAILY', '2026-10-31', '08:30', 'America/New_York'),
        '2026-10-30T00:00:00Z',
        3,
      ),
    ).toEqual([
      '2026-10-31T12:30:00.000Z',
      '2026-11-01T13:30:00.000Z',
      '2026-11-02T13:30:00.000Z',
    ]);
  });

  it('moves a time the clock skips to the moment after the gap, once', () => {
    // 02:30 does not exist on 2026-03-08 in New York: 03:30 EDT, still one occurrence that day.
    expect(
      upcoming(
        schedule('FREQ=DAILY', '2026-03-07', '02:30', 'America/New_York'),
        '2026-03-07T00:00:00Z',
        3,
      ),
    ).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
  });

  it('takes the first of a time the clock repeats, once', () => {
    // 01:30 happens twice on 2026-11-01 in New York: the EDT one only.
    expect(
      upcoming(
        schedule('FREQ=DAILY', '2026-10-31', '01:30', 'America/New_York'),
        '2026-10-31T00:00:00Z',
        3,
      ),
    ).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });
});
