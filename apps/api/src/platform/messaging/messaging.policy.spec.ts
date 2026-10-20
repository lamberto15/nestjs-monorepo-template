import {
  allowedPrefix,
  clip,
  clipBytes,
  inboundKeyword,
  maskPhone,
  utcDay,
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
