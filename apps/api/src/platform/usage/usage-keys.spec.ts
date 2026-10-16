import {
  addDays,
  daysBetween,
  parseUsageKey,
  secondsToUtcMidnight,
  usageKey,
} from './usage-keys.js';

// routeKey (re-exported from core): src/core/http/route-key.spec.ts.
describe('usage keys', () => {
  it('walks UTC days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
    expect(daysBetween('2026-02-02', '2026-02-01')).toEqual([]);
  });

  it('counts the seconds to UTC midnight', () => {
    expect(secondsToUtcMidnight(new Date('2026-10-16T23:59:00Z'))).toBe(60);
    expect(secondsToUtcMidnight(new Date('2026-10-16T00:00:00Z'))).toBe(86_400);
  });

  it('reads back the keys it writes', () => {
    const id = '0199a3f2-0000-7000-8000-000000000000';
    expect(parseUsageKey(usageKey(id, '2026-10-16'))).toEqual({
      clientId: id,
      day: '2026-10-16',
    });
    expect(parseUsageKey('usage:nope:2026-10-16')).toBeUndefined();
  });
});
