import {
  allowedPrefix,
  clip,
  clipBytes,
  inboundKeyword,
  maskPhone,
  utcDay,
  previousMonthStart,
  smsCost,
  smsSegments,
  utcMonthStart,
  webPushKey,
} from './messaging.policy.js';

describe('inboundKeyword', () => {
  it.each([
    'STOP',
    'stop',
    ' Stop ',
    'STOPALL',
    'unsubscribe',
    'CANCEL',
    'end',
    'QUIT',
  ])('reads %j as an opt-out', (body) =>
    expect(inboundKeyword(body)).toBe('stop'),
  );
  it.each(['START', 'yes', 'Unstop'])('reads %j as an opt-in', (body) =>
    expect(inboundKeyword(body)).toBe('start'),
  );
  it.each(['please stop', 'stop it', 'yes please', '', 'HELP', 'STOP.'])(
    'ignores %j: only the whole message is a command',
    (body) => expect(inboundKeyword(body)).toBeNull(),
  );
});

describe('allowedPrefix', () => {
  it('matches the longest allowed prefix', () => {
    expect(allowedPrefix('+447700900123', ['+1', '+44'])).toBe('+44');
    expect(allowedPrefix('+15551234567', ['+1', '+1555'])).toBe('+1555');
  });
  it('refuses a number outside the list, and everything when the list is empty', () => {
    expect(allowedPrefix('+4915112345678', ['+1', '+44'])).toBeNull();
    expect(allowedPrefix('+447700900123', [])).toBeNull();
  });
  it('never matches a malformed entry', () => {
    expect(allowedPrefix('+447700900123', ['44', '+', '+0', '*'])).toBeNull();
  });
});

describe('clipping', () => {
  it('cuts text with an ellipsis, by characters', () => {
    expect(clip('hello', 10)).toBe('hello');
    expect(clip('hello world', 6)).toBe('hello…');
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…');
  });
  it('cuts by bytes without splitting a character', () => {
    expect(clipBytes('abc', 10)).toBe('abc');
    const cut = clipBytes('😀'.repeat(10), 12);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(12);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('�');
  });
});

it('masks a number but its country prefix and last digits', () => {
  expect(maskPhone('+4915112345678')).toBe('+49•••••••••78');
  expect(maskPhone('+12345')).toBe('••••');
});

it('counts the UTC day', () => {
  expect(utcDay(new Date('2026-10-20T23:59:59Z'))).toBe('2026-10-20');
});

describe('SMS cost', () => {
  it('counts segments: 160 ASCII characters, then 153 each; 70 and 67 with Unicode', () => {
    expect(smsSegments('')).toBe(1);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
    expect(smsSegments('é'.repeat(70))).toBe(1);
    expect(smsSegments('é'.repeat(71))).toBe(2);
    expect(smsSegments('é'.repeat(135))).toBe(3);
  });

  it('prices the segments by prefix, else the default', () => {
    const prices = { '+1': 79, '+44': 120 };
    expect(smsCost('hi', '+44', prices, 5)).toBe(120);
    expect(smsCost('a'.repeat(200), '+1', prices, 5)).toBe(158);
    expect(smsCost('hi', '+49', prices, 5)).toBe(5);
    expect(smsCost('hi', '+49', prices, 0)).toBe(0);
  });

  it('names the month the spend counts in', () => {
    const now = new Date('2026-03-31T23:59:59Z');
    expect(utcMonthStart(now)).toBe('2026-03-01');
    expect(previousMonthStart(now)).toBe('2026-02-01');
    expect(previousMonthStart(new Date('2026-01-05T00:00:00Z'))).toBe(
      '2025-12-01',
    );
  });
});

describe('webPushKey', () => {
  it('is the public key when Web Push is a provider', () =>
    expect(webPushKey(['apns', 'web-push'], 'BKey')).toBe('BKey'));

  it('is null when Web Push is off or has no key', () => {
    expect(webPushKey(['memory'], 'BKey')).toBeNull();
    expect(webPushKey([], 'BKey')).toBeNull();
    expect(webPushKey(['web-push'], undefined)).toBeNull();
  });
});
