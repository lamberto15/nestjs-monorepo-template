import { getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import { uuidPk } from '../../core/database/columns.js';
import { field } from './field.js';
import {
  fieldColumns,
  fieldExtras,
  fieldSamples,
  fieldSchemas,
  fieldValues,
  fieldView,
} from './fields.js';
import { fieldList } from './fields.list.js';

const customers = pgTable('test_customers', {
  id: uuidPk(),
  tenantId: tenantColumn(),
});

const FIELDS = {
  title: field.string().searchable(),
  notes: field.text().optional(),
  quantity: field.int(),
  total: field.money(),
  discount: field.money().optional(),
  paid: field.bool(),
  dueOn: field.date().optional(),
  sentAt: field.datetime().optional(),
  status: field.enum(['draft', 'sent', 'paid']).default('draft'),
  code: field.string().unique(),
  customerId: field.ref(() => customers).optional(),
};

const invoices = pgTable(
  'test_invoices',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id').notNull(),
    ...fieldColumns(FIELDS),
  },
  (table) => [
    ...tenantTable('test_invoices', table, { referenced: true }),
    ...fieldExtras('test_invoices', table, FIELDS),
  ],
);

/** Fields declared once (field.ts): the table, schemas and mapping derived from them. */
describe('fields', () => {
  it('makes the columns: names, NOT NULL, defaults, money as two', () => {
    const config = getTableConfig(invoices);
    const columns = Object.fromEntries(config.columns.map((c) => [c.name, c]));
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'title',
        'notes',
        'quantity',
        'total_minor',
        'total_currency',
        'discount_minor',
        'paid',
        'due_on',
        'sent_at',
        'status',
        'code',
        'customer_id',
      ]),
    );
    expect(columns.title!.notNull).toBe(true);
    expect(columns.notes!.notNull).toBe(false);
    expect(columns.total_minor!.notNull).toBe(true);
    expect(columns.discount_minor!.notNull).toBe(false);
    expect(columns.paid!.default).toBe(false);
    expect(columns.status!.default).toBe('draft');
  });

  it("makes a unique field's per-tenant index and a reference's key within the tenant", () => {
    const config = getTableConfig(invoices);
    expect(config.indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining([
        'test_invoices_code_idx',
        'test_invoices_customer_id_idx',
      ]),
    );
    expect(config.foreignKeys.map((k) => k.getName())).toContain(
      'test_invoices_customer_id_fk',
    );
  });

  it('types the row and the insert exactly', () => {
    type Row = typeof invoices.$inferSelect;
    type Insert = typeof invoices.$inferInsert;
    expectTypeOf<Row['title']>().toEqualTypeOf<string>();
    expectTypeOf<Row['notes']>().toEqualTypeOf<string | null>();
    expectTypeOf<Row['totalMinor']>().toEqualTypeOf<bigint>();
    expectTypeOf<Row['discountMinor']>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Row['status']>().toEqualTypeOf<'draft' | 'sent' | 'paid'>();
    expectTypeOf<Row['sentAt']>().toEqualTypeOf<Date | null>();
    // Defaulted and optional columns may be left out; required ones may not.
    expectTypeOf<Insert>()
      .toHaveProperty('status')
      .toEqualTypeOf<'draft' | 'sent' | 'paid' | undefined>();
    expectTypeOf<Insert['title']>().toEqualTypeOf<string>();
  });

  it('derives the schemas: required, optional (null or absent), defaulted (absent)', () => {
    const { create, update } = fieldSchemas(FIELDS);
    const body = fieldSamples(FIELDS).body();
    expect(create.parse(body)).toMatchObject({ title: 'title 1' });
    const { status: _status, notes: _notes, ...minimal } = body;
    expect(create.safeParse(minimal).success).toBe(true);
    const { title: _title, ...withoutTitle } = body;
    expect(create.safeParse(withoutTitle).success).toBe(false);
    expect(create.safeParse({ ...body, notes: null }).success).toBe(true);
    expect(update.safeParse({ quantity: 4 }).success).toBe(true);
    expect(
      create.safeParse({ ...body, ...fieldSamples(FIELDS).invalid }).success,
    ).toBe(false);
    type Create = ReturnType<typeof create.parse>;
    expectTypeOf<Create['notes']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Create['total']['amount']>().toEqualTypeOf<string>();
  });

  it('writes money as minor units and currency, a datetime as a Date, and shows them back', () => {
    const values = fieldValues(FIELDS, {
      total: { amount: '19.99', currency: 'EUR' },
      discount: null,
      sentAt: '2026-01-31T09:00:00.000Z',
      title: 'A',
    });
    expect(values).toEqual({
      totalMinor: 1999n,
      totalCurrency: 'EUR',
      discountMinor: null,
      discountCurrency: null,
      sentAt: new Date('2026-01-31T09:00:00.000Z'),
      title: 'A',
    });
    const view = fieldView(FIELDS, {
      id: '1',
      totalMinor: 1999n,
      totalCurrency: 'EUR',
      discountMinor: null,
      discountCurrency: null,
    });
    expect(view).toEqual({
      id: '1',
      total: { amount: '19.99', currency: 'EUR' },
      discount: null,
    });
  });

  it('lists by each field as its type allows', () => {
    const list = fieldList(FIELDS, invoices as never) as Record<
      string,
      { type: string; ops: string[] }
    >;
    expect(list.title).toMatchObject({ type: 'string', sortable: true });
    expect(list.totalCurrency).toMatchObject({
      type: 'string',
      ops: ['eq', 'in'],
    });
    expect(list.notes!.ops).toContain('isNull');
    expect(list.status).toMatchObject({
      type: 'enum',
      values: ['draft', 'sent', 'paid'],
    });
    expect(list.meta).toBeUndefined();
  });
});
