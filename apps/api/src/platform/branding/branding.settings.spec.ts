import {
  BRANDING_LOCKED,
  BRANDING_MAIL_FROM_NAME,
  BRANDING_PRIMARY_COLOR,
} from './branding.settings.js';

describe('branding settings', () => {
  const color = (value: unknown) =>
    BRANDING_PRIMARY_COLOR.schema.safeParse(value).success;
  const name = (value: unknown) =>
    BRANDING_MAIL_FROM_NAME.schema.safeParse(value).success;

  it.each(['#000000', '#FFFFFF', '#0a84ff', '#AbCdEf', null])(
    'takes the colour %j',
    (value) => {
      expect(color(value)).toBe(true);
    },
  );

  it.each([
    'red',
    '#fff',
    '#12345',
    '#1234567',
    '#gggggg',
    ' #000000',
    '#000000 ',
    '#000000\n',
    '#000000;color:red',
    'rgb(0,0,0)',
    'var(--primary)',
    'url(https://evil.example/x)',
    '#000000" onload="x',
    '</style><script>',
    '',
    7,
    undefined,
  ])('refuses the colour %j', (value) => {
    expect(color(value)).toBe(false);
  });

  it.each([
    'Acme',
    'Acme Support',
    'Müller & Söhne',
    'شركة',
    '株式会社 例',
    'A.B. (UK)',
  ])('takes the sender name %j', (value) => {
    expect(name(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'a'.repeat(61),
    'Evil\r\nBcc: x@example.com',
    'a\u0000b',
    'x‮y',
    'Name <a@b.c>',
    'a@b.c',
    '"quoted"',
    'a, b',
    'a; b',
    'a: b',
    'back\\slash',
  ])('refuses the sender name %j', (value) => {
    expect(name(value)).toBe(false);
  });

  it('trims the sender name', () => {
    expect(BRANDING_MAIL_FROM_NAME.schema.parse('  Acme  ')).toBe('Acme');
  });

  it('has no scope for the lock: only the operators set it', () => {
    expect(BRANDING_LOCKED.scopes).toEqual([]);
    expect(BRANDING_LOCKED.default).toBe(false);
  });
});
