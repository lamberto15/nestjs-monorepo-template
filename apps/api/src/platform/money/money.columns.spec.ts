import { getTableColumns } from 'drizzle-orm';
import { pgTable } from 'drizzle-orm/pg-core';
import { uuidPk } from '../../core/database/columns.js';
import {
  conversionColumns,
  conversionValues,
  moneyColumns,
  moneyOf,
  moneyValues,
} from './money.columns.js';
import { Money } from './money.js';

const invoices = pgTable('invoices', {
  id: uuidPk(),
  ...moneyColumns('total'),
  ...moneyColumns('unitDiscount', { nullable: true }),
  ...conversionColumns('totalEur'),
});

describe('money columns', () => {
  it('adds snake_case columns: bigint minor units and a char(3) code, NOT NULL unless nullable', () => {
    const columns = getTableColumns(invoices);
    expect(columns.totalMinor.name).toBe('total_minor');
    expect(columns.totalMinor.getSQLType()).toBe('bigint');
    expect(columns.totalMinor.notNull).toBe(true);
    expect(columns.totalCurrency.name).toBe('total_currency');
    expect(columns.totalCurrency.getSQLType()).toBe('char(3)');
    expect(columns.unitDiscountMinor.name).toBe('unit_discount_minor');
    expect(columns.unitDiscountMinor.notNull).toBe(false);
    expect(columns.totalEurRate.getSQLType()).toBe('numeric');
    expect(columns.totalEurRateDate.name).toBe('total_eur_rate_date');
    expect(columns.totalEurRateSource.name).toBe('total_eur_rate_source');
  });

  it('reads minor units as JS bigints and rates as strings (the drivers’ values mapped as the rows are)', () => {
    // Runtime checks on the column config: vitest doesn't type-check specs.
    const columns = getTableColumns(invoices);
    expect(columns.totalMinor.dataType).toBe('bigint');
    expect(columns.totalMinor.columnType).toBe('PgBigInt64');
    expect(columns.totalMinor.mapFromDriverValue('9223372036854775807')).toBe(
      9223372036854775807n,
    );
    expect(columns.unitDiscountMinor.dataType).toBe('bigint');
    expect(columns.totalCurrency.dataType).toBe('string');
    expect(columns.totalEurRate.dataType).toBe('string');
    expect(columns.totalEurRate.notNull).toBe(false);
    expect(columns.totalEurRateDate.dataType).toBe('string');
  });

  it('writes and reads an amount and a conversion', () => {
    const total = Money.of('12.34', 'EUR');
    const values = {
      ...moneyValues('total', total),
      ...conversionValues('totalEur', {
        rate: '1.1652',
        rateDate: '2026-10-15',
        source: 'ecb',
      }),
    };
    expect(values).toEqual({
      totalMinor: 1234n,
      totalCurrency: 'EUR',
      totalEurRate: '1.1652',
      totalEurRateDate: '2026-10-15',
      totalEurRateSource: 'ecb',
    });
    expect(moneyOf(values, 'total')?.equals(total)).toBe(true);
    expect(
      moneyOf({ discountMinor: null, discountCurrency: null }, 'discount'),
    ).toBeNull();
  });
});
