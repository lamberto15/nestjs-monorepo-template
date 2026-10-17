import { getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import { uuidPk } from '../../core/database/columns.js';
import { z } from 'zod';
import {
  JSON_BODY_LIMIT,
  MAX_TEXT_LENGTH,
} from '../../core/http/body-limit.js';
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
import { defineRecord, recordTable } from '../records/record.js';

// A record's table knows its subject: a reference to it lists as ids of Customer.
const customers = recordTable(
  defineRecord({
    subject: 'Customer',
    path: 'customers',
    apiTag: 'customers',
    className: 'Customer',
    noun: 'customer',
    table: 'test_customers',
    softDelete: false,
    team: false,
    clientAccess: false,
    grants: 'standard',
    fields: { name: field.string() },
    capabilities: [],
  }),
);
// A hand-written table is named by the field.
const places = pgTable('test_places', {
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

  it('makes the unique index partial on live rows when the table has soft delete, plain otherwise', () => {
    const table = (name: string, softDelete: boolean) =>
      pgTable(
        name,
        {
          id: uuidPk(),
          tenantId: tenantColumn(),
          ...fieldColumns({ code: FIELDS.code }),
        },
        (t) => fieldExtras(name, t, { code: FIELDS.code }, softDelete),
      );
    const code = (softDelete: boolean) =>
      getTableConfig(table(`t_${softDelete}`, softDelete)).indexes.find((i) =>
        i.config.name?.endsWith('_code_idx'),
      )!.config;
    expect(code(false).unique).toBe(true);
    expect(code(false).where).toBeUndefined();
    expect(code(true).unique).toBe(true);
    expect(code(true).where).toBeDefined();
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

  it('bounds every text field under the request body limit, as maxLength in the schema', () => {
    const { create } = fieldSchemas(FIELDS);
    const json = z.toJSONSchema(create, { io: 'input' }) as {
      properties: Record<string, { maxLength?: number }>;
    };
    expect(json.properties.title!.maxLength).toBe(200);
    expect(json.properties.code!.maxLength).toBe(200);
    // `notes` is optional: null or a string, the string bounded.
    expect(JSON.stringify(json.properties.notes)).toContain(
      '"maxLength":10000',
    );
    expect(() => field.text(MAX_TEXT_LENGTH)).not.toThrow();
    expect(() => field.text(MAX_TEXT_LENGTH + 1)).toThrow(/body limit/);
    expect(() => field.string(MAX_TEXT_LENGTH + 1)).toThrow(/body limit/);
    expect(() => field.text(0)).toThrow(/1 to/);
    // One field at its longest, in a 3-byte script, still fits the body.
    expect(
      Buffer.byteLength(JSON.stringify({ body: '€'.repeat(MAX_TEXT_LENGTH) })),
    ).toBeLessThan(JSON_BODY_LIMIT);
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
      // Its permission is the money field's (field-level).
      reads: ['total'],
    });
    expect(list.title).not.toHaveProperty('reads');
    expect(list.notes!.ops).toContain('isNull');
    expect(list.status).toMatchObject({
      type: 'enum',
      values: ['draft', 'sent', 'paid'],
    });
    expect(list.meta).toBeUndefined();
  });

  it("says what a reference lists: its record's subject, or the one the field names", () => {
    const list = fieldList(FIELDS, invoices as never) as Record<
      string,
      { ref?: string }
    >;
    expect(list.customerId).toMatchObject({ type: 'uuid', ref: 'Customer' });
    // Plain fields say nothing.
    expect(list.title).not.toHaveProperty('ref');
    const named = fieldList(
      { placeId: field.ref(() => places, 'Place').optional() },
      invoices as never,
    ) as Record<string, { ref?: string }>;
    expect(named.placeId).toMatchObject({ ref: 'Place' });
    // A table that is neither: no guess.
    expect(() =>
      fieldList(
        { placeId: field.ref(() => places).optional() },
        invoices as never,
      ),
    ).toThrow(/field\.ref\(\(\) => table, 'Subject'\)/);
  });
});
