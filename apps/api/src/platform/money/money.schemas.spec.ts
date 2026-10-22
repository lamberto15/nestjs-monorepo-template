import { moneySchema } from './money.schemas.js';

const issues = (amount: string, currency: string) =>
  moneySchema
    .safeParse({ amount, currency })
    .error?.issues.map((issue) => issue.message) ?? [];

describe('moneySchema', () => {
  it("takes at most the currency's decimals, trailing zeros not counted", () => {
    expect(issues('12.34', 'EUR')).toEqual([]);
    expect(issues('12.340', 'EUR')).toEqual([]);
    expect(issues('12.3400000', 'EUR')).toEqual([]);
    expect(issues('12', 'EUR')).toEqual([]);
    expect(issues('100.000', 'JPY')).toEqual([]);
    expect(issues('12.345', 'EUR')).toEqual([
      'has more decimals than EUR has (2)',
    ]);
    expect(issues('12.3450', 'EUR')).toEqual([
      'has more decimals than EUR has (2)',
    ]);
    expect(issues('100.5', 'JPY')).toEqual([
      'has more decimals than JPY has (0)',
    ]);
  });

  it('refuses a long amount of zeros quickly', () => {
    const started = performance.now();
    expect(issues(`1.${'0'.repeat(50_000)}1`, 'EUR')).not.toEqual([]);
    expect(issues(`1.${'0'.repeat(50_000)}`, 'EUR')).not.toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
