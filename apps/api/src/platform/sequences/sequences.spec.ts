import { formatNumber } from './sequences.service.js';

describe('formatNumber', () => {
  it('pads and joins the parts that are there', () => {
    expect(formatNumber(42, { prefix: 'INV', width: 5 }, '2026')).toBe(
      'INV-2026-00042',
    );
    expect(formatNumber(42, { prefix: 'INV' })).toBe('INV-42');
    expect(formatNumber(42, { width: 3 }, '2026')).toBe('2026-042');
    expect(formatNumber(7, {})).toBe('7');
    expect(
      formatNumber(123456, { prefix: 'T', width: 3, separator: '/' }),
    ).toBe('T/123456');
  });
});
