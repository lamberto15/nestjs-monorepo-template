import { compileExpression, EXPRESSION_LIMITS } from './expression.js';

const VARIABLES = {
  quantity: 'int',
  rate: 'decimal',
  unitPrice: 'money',
  other: 'money',
  title: 'string',
  body: 'string',
  done: 'bool',
  startOn: 'date',
  endOn: 'date',
  openedAt: 'datetime',
  closedAt: 'datetime',
} as const;

const run = (source: string, values: Record<string, unknown> = {}) =>
  compileExpression(source, VARIABLES).evaluate(values);
const refused = (source: string, code: string) =>
  expect(() => compileExpression(source, VARIABLES)).toThrow(
    expect.objectContaining({ code }),
  );

describe('compileExpression', () => {
  it('computes exact numbers and money, typed', () => {
    const total = compileExpression('quantity * unitPrice', VARIABLES);
    expect(total.type).toBe('money');
    expect(total.reads).toEqual(['quantity', 'unitPrice']);
    expect(
      total.evaluate({
        quantity: 3,
        unitPrice: { amount: '19.99', currency: 'EUR' },
      }),
    ).toEqual({ amount: '59.97', currency: 'EUR' });
    expect(run('0.1 + 0.2')).toBe('0.3');
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('10 / 4')).toBe('2.5');
    expect(run('6 / 3')).toBe('2');
    expect(run('1 / 3')).toBe('0.3333333333');
    expect(run('rate * 2', { rate: '0.19' })).toBe('0.38');
    expect(run('round(2.345, 2)')).toBe('2.35');
    expect(run('round(2.5)')).toBe(3);
    expect(run('floor(-2.5) + ceil(2.1)')).toBe(0);
    expect(run('-quantity', { quantity: 2 })).toBe(-2);
    expect(
      run('unitPrice / 3', { unitPrice: { amount: '10.00', currency: 'EUR' } }),
    ).toEqual({ amount: '3.33', currency: 'EUR' });
    expect(
      run('unitPrice / other', {
        unitPrice: { amount: '5.00', currency: 'EUR' },
        other: { amount: '20.00', currency: 'EUR' },
      }),
    ).toBe('0.25');
  });

  it('compares, branches and handles null', () => {
    expect(run('quantity > 2 and not done', { quantity: 3, done: false })).toBe(
      true,
    );
    expect(run("if(done, 'closed', 'open')", { done: null })).toBe('open');
    expect(run('quantity + 1')).toBeNull();
    expect(run('quantity == null')).toBe(true);
    expect(run('coalesce(quantity, 0) + 1')).toBe(1);
    expect(run('max(1, 2.5, quantity)', { quantity: 2 })).toBe('2.5');
    expect(run("title < 'b'", { title: 'a' })).toBe(true);
  });

  it('works with text and dates', () => {
    expect(
      run("concat(upper(title), ': ', trim(body))", {
        title: 'hi',
        body: '  there ',
      }),
    ).toBe('HI: there');
    expect(run("length('héllo')")).toBe(5);
    expect(
      run('text(unitPrice)', {
        unitPrice: { amount: '1.50', currency: 'EUR' },
      }),
    ).toBe('1.50 EUR');
    expect(
      run('daysBetween(startOn, endOn) + 1', {
        startOn: '2026-02-27',
        endOn: '2026-03-02',
      }),
    ).toBe(4);
    expect(run("addDays(date('2026-12-31'), 1)")).toBe('2027-01-01');
    expect(
      run('minutesBetween(openedAt, closedAt)', {
        openedAt: new Date('2026-01-01T09:00:00Z'),
        closedAt: '2026-01-01T10:30:00.000Z',
      }),
    ).toBe(90);
    expect(
      run('startOn < endOn', { startOn: '2026-01-02', endOn: '2026-01-10' }),
    ).toBe(true);
  });

  it('refuses what is not a valid, typed expression of the allowlist', () => {
    refused('quantity +', 'syntax');
    refused('1 < 2 < 3', 'syntax');
    refused('title; drop table x', 'syntax');
    refused('`x`', 'syntax');
    refused('secret', 'unknown_name');
    refused('constructor', 'unknown_name');
    refused('__proto__', 'unknown_name');
    refused('eval(title)', 'unknown_function');
    refused('toString()', 'unknown_function');
    refused('title + 1', 'type');
    refused('unitPrice * unitPrice', 'type');
    refused('done and 1', 'type');
    refused("quantity == 'x'", 'type');
    refused('round(rate, quantity)', 'type');
    refused('null', 'type');
  });

  it('is bounded: length, parts, depth, magnitude', () => {
    refused('1+'.repeat(EXPRESSION_LIMITS.source) + '1', 'too_long');
    refused(Array(EXPRESSION_LIMITS.nodes).fill('1').join('+'), 'too_complex');
    refused(
      '('.repeat(EXPRESSION_LIMITS.depth + 1) +
        '1' +
        ')'.repeat(EXPRESSION_LIMITS.depth + 1),
      'too_deep',
    );
    refused('9'.repeat(EXPRESSION_LIMITS.digits + 1), 'out_of_range');
    const big = '9'.repeat(EXPRESSION_LIMITS.digits);
    expect(() => run(`${big} * ${big}`)).toThrow(
      expect.objectContaining({ code: 'out_of_range' }),
    );
  });

  it('fails a value it cannot compute, never a wrong one', () => {
    const fails = (
      source: string,
      values: Record<string, unknown>,
      code: string,
    ) =>
      expect(() => run(source, values)).toThrow(
        expect.objectContaining({ code }),
      );
    fails('quantity / 0', { quantity: 1 }, 'division_by_zero');
    fails(
      'unitPrice + other',
      {
        unitPrice: { amount: '1.00', currency: 'EUR' },
        other: { amount: '1.00', currency: 'USD' },
      },
      'currency_mismatch',
    );
    fails('quantity + 1', { quantity: 'three' }, 'invalid_value');
    fails('quantity + 1', { quantity: 1.5 }, 'invalid_value');
    fails("date('2026-02-30') == startOn", {}, 'invalid_value');
  });
});
