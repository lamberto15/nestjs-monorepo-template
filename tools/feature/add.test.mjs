// The feature generator's tests (tools/feature/add.mjs):
//   node --test tools/feature/add.test.mjs
// They write into a scratch copy of the files it touches; the generated code
// itself is compiled and its e2e test run by CI's feature smoke step.
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { addFeature, MARKERS } from './add.mjs';
import { readRecord, syncFeature } from './sync.mjs';
import { numberPrefix, parseCapabilities } from './capabilities.mjs';
import { parseField, parseFields } from './fields.mjs';
import { names, singularize } from './names.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('names', () => {
  it('derives every form from a plural kebab-case name', () => {
    const t = names('invoice-lines');
    assert.equal(t.singular, 'invoice-line');
    assert.equal(t.pluralCamel, 'invoiceLines');
    assert.equal(t.Plural, 'InvoiceLines');
    assert.equal(t.Singular, 'InvoiceLine');
    assert.equal(t.SINGULAR, 'INVOICE_LINE');
    assert.equal(t.table, 'invoice_lines');
    assert.equal(t.aNoun, 'an invoice line');
  });

  it('singularizes the common English plurals, and asks for the rest', () => {
    assert.equal(singularize('categories'), 'category');
    assert.equal(singularize('boxes'), 'box');
    assert.equal(singularize('notes'), 'note');
    assert.equal(singularize('addresses'), 'address');
    assert.equal(singularize('status'), null);
    assert.throws(() => names('people'), /--singular/);
    assert.equal(names('people', 'person').Singular, 'Person');
  });

  it('refuses a name that is not kebab-case', () => {
    assert.throws(() => names('Invoices'), /lowercase/);
    assert.throws(() => names('invoice_lines'), /lowercase/);
  });
});

describe('fields', () => {
  it('reads types, optional and unique', () => {
    assert.deepEqual(parseField('dueOn:date?'), {
      name: 'dueOn',
      column: 'due_on',
      type: 'date',
      optional: true,
      unique: false,
    });
    assert.deepEqual(parseField('status:enum(draft|sent)').values, [
      'draft',
      'sent',
    ]);
    assert.equal(parseField('code:string!unique').unique, true);
    assert.equal(parseField('customerId:ref(customers)?').ref, 'customers');
  });

  it('refuses what the generated code could not honour', () => {
    assert.throws(() => parseField('ownerId:string'), /every feature has/);
    assert.throws(() => parseField('title:varchar'), /not a type/);
    assert.throws(() => parseField('status:enum(one)'), /two values/);
    assert.throws(() => parseField('customer:ref(customers)?'), /ends with Id/);
    assert.throws(() => parseField('customerId:ref(customers)'), /optional/);
    assert.throws(() => parseField('paid:bool!unique'), /string and int/);
    assert.throws(() => parseFields('title:string,title:text'), /twice/);
    assert.throws(() => parseFields(''), /at least one/);
  });
});

describe('capabilities', () => {
  const fields = parseFields('title:string');
  it('reads --with, and a PDF brings attachments (it is one)', () => {
    assert.deepEqual([...parseCapabilities('pdf,tags', fields)].sort(), [
      'attachments',
      'pdf',
      'tags',
    ]);
    assert.equal(parseCapabilities(undefined, fields).size, 0);
  });

  it('takes events and numbered, and derives the number prefix', () => {
    assert.deepEqual([...parseCapabilities('events,numbered', fields)].sort(), [
      'events',
      'numbered',
    ]);
    assert.equal(numberPrefix('Invoice'), 'INV');
    assert.equal(numberPrefix('InvoiceLine'), 'IL');
  });

  it('refuses an unknown one, and search without text to search', () => {
    assert.throws(() => parseCapabilities('likes', fields), /not a capability/);
    assert.throws(
      () => parseCapabilities('search', parseFields('total:money')),
      /string or text field/,
    );
  });
});

describe('addFeature', () => {
  let root;
  const api = (...parts) => path.join(root, 'apps/api', ...parts);

  before(() => {
    // The files the generator reads and appends to, as the repository has them.
    root = mkdtempSync(path.join(tmpdir(), 'feature-add-'));
    copyFileSync(
      path.join(REPO, '.prettierrc'),
      path.join(root, '.prettierrc'),
    );
    for (const file of [
      'src/features/index.ts',
      'src/features/tables.ts',
      'test/openapi.e2e-spec.ts',
      ...['ar', 'de', 'en', 'ms', 'zh'].flatMap((locale) => [
        `src/i18n/${locale}/notifications.json`,
        `src/i18n/${locale}/documents.json`,
      ]),
    ]) {
      mkdirSync(path.dirname(api(file)), { recursive: true });
      copyFileSync(path.join(REPO, 'apps/api', file), api(file));
    }
    // A table the generator may not reference: no `referenced: true`.
    mkdirSync(api('src/features/ledgers'), { recursive: true });
    writeFileSync(
      api('src/features/ledgers/ledgers.tables.ts'),
      "export const ledgers = pgTable('ledgers', {});\n",
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('writes the standard files and appends to the lists once', async () => {
    const result = await addFeature(root, {
      name: 'invoices',
      fields: 'title:string,total:money,status:enum(draft|paid)',
    });
    for (const file of [
      'invoices.tables.ts',
      'invoice.schemas.ts',
      'invoice.list.ts',
      'invoice.resource.ts',
      'invoice.policy.ts',
      'invoices.service.ts',
      'invoices.controller.ts',
      'invoice.record.ts',
      'invoices.module.ts',
      'invoices.feature.ts',
    ]) {
      assert.ok(existsSync(api('src/features/invoices', file)), file);
    }
    assert.ok(existsSync(api('test/invoices.e2e-spec.ts')));
    assert.ok(result.changed.includes('apps/api/src/features/index.ts'));
    assert.ok(
      result.changed.includes('OpenAPI test: + /v1/invoices/{id}/restore'),
    );

    const index = readFileSync(api('src/features/index.ts'), 'utf8');
    assert.equal(index.match(/INVOICES_FEATURE,/g)?.length, 1);
    assert.ok(
      index.includes(MARKERS.imports) && index.includes(MARKERS.features),
    );
    assert.match(
      readFileSync(api('src/features/tables.ts'), 'utf8'),
      /export \* from '\.\/invoices\/invoices\.tables\.js';/,
    );

    // The fields declared once: the table and schemas derive from them.
    const record = readFileSync(
      api('src/features/invoices/invoice.record.ts'),
      'utf8',
    );
    assert.match(record, /total: field\.money\(\),/);
    assert.match(record, /status: field\.enum\(\['draft', 'paid'\]\),/);
    assert.match(record, /capabilities: \[\]/);
    assert.match(
      readFileSync(api('src/features/invoices/invoices.tables.ts'), 'utf8'),
      /recordTable\(INVOICE\)/,
    );
  });

  it('adds the paths to the OpenAPI test in its sorted order', async () => {
    const spec = readFileSync(api('test/openapi.e2e-spec.ts'), 'utf8');
    const paths = [...spec.matchAll(/^\s+'(\/v1\/[^']*)',$/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(paths, [...paths].sort());
    for (const p of [
      '/v1/invoices',
      '/v1/invoices/{id}',
      '/v1/invoices/{id}/restore',
    ]) {
      assert.ok(paths.includes(p), p);
    }
  });

  it('appends a second feature after the first, and refuses one that exists', async () => {
    await addFeature(root, {
      name: 'payments',
      fields: 'amount:money,invoiceId:ref(invoices)?',
      softDelete: false,
    });
    const index = readFileSync(api('src/features/index.ts'), 'utf8');
    assert.ok(
      index.indexOf('INVOICES_FEATURE,') < index.indexOf('PAYMENTS_FEATURE,'),
    );
    const spec = readFileSync(api('test/openapi.e2e-spec.ts'), 'utf8');
    assert.ok(!spec.includes("'/v1/payments/{id}/restore'"));
    await assert.rejects(
      addFeature(root, { name: 'invoices', fields: 'title:string' }),
      /exists already/,
    );
  });

  it('declares the capabilities, and writes their texts in every locale', async () => {
    const result = await addFeature(root, {
      name: 'tickets',
      fields: 'title:string,body:text',
      with: 'tags,comments,pdf,bulk,watch,search,revisions,transfer',
    });
    // The platform's generic targets and routes: no file of the feature's.
    const record = readFileSync(
      api('src/features/tickets/ticket.record.ts'),
      'utf8',
    );
    assert.match(record, /'tags',[\s\S]*'transfer'/);
    assert.match(record, /title: field\.string\(\)\.searchable\(\)/);
    assert.ok(!existsSync(api('src/features/tickets/ticket-tags.ts')));
    assert.match(
      readFileSync(api('src/features/tickets/tickets.module.ts'), 'utf8'),
      /recordParts\(TICKET/,
    );
    // Arabic gets its six plural forms; Chinese its one.
    const ar = JSON.parse(
      readFileSync(api('src/i18n/ar/notifications.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(ar.ticket.commented.body).sort(), [
      'few',
      'many',
      'one',
      'other',
      'two',
      'zero',
    ]);
    const zh = JSON.parse(
      readFileSync(api('src/i18n/zh/notifications.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(zh.ticket.commented.body), ['other']);
    assert.ok(result.translate.includes('de/documents.json: ticket'));
    const spec = readFileSync(api('test/openapi.e2e-spec.ts'), 'utf8');
    assert.ok(spec.includes("'/v1/tickets/{id}/revisions/{a}/diff/{b}'"));
  });

  it('declares events and numbered: the number format, and the number in the PDF labels', async () => {
    await addFeature(root, {
      name: 'quotes',
      fields: 'title:string',
      with: 'events,numbered,pdf',
    });
    const record = readFileSync(
      api('src/features/quotes/quote.record.ts'),
      'utf8',
    );
    assert.match(
      record,
      /number: \{ prefix: 'QUO', perYear: true, width: 5 \},/,
    );
    assert.match(record, /'events', 'numbered'/);
    const documents = JSON.parse(
      readFileSync(api('src/i18n/en/documents.json'), 'utf8'),
    );
    assert.equal(documents.quote.fields.number, 'Number');
    // The service takes the number and tells the lifecycle of every write.
    const service = readFileSync(
      api('src/features/quotes/quotes.service.ts'),
      'utf8',
    );
    assert.match(service, /lifecycle\.creating\(tx\)/);
    assert.match(service, /lifecycle\.deleted\(tx/);
    assert.match(service, /lifecycle\.restored\(tx/);
  });

  it("refuses a reference to a table others can't point at", async () => {
    await assert.rejects(
      addFeature(root, { name: 'receipts', fields: 'ledgerId:ref(ledgers)?' }),
      /referenced: true/,
    );
    await assert.rejects(
      addFeature(root, { name: 'tenants', fields: 'title:string' }),
      /taken/,
    );
  });
});

describe('feature:sync', () => {
  let root;
  const api = (...parts) => path.join(root, 'apps/api', ...parts);
  const record = () => api('src/features/orders/order.record.ts');
  const edit = (from, to) => {
    const text = readFileSync(record(), 'utf8');
    assert.ok(text.includes(from), from);
    writeFileSync(record(), text.replace(from, to));
  };

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'feature-sync-'));
    copyFileSync(
      path.join(REPO, '.prettierrc'),
      path.join(root, '.prettierrc'),
    );
    for (const file of [
      'src/features/index.ts',
      'src/features/tables.ts',
      'test/openapi.e2e-spec.ts',
      ...['ar', 'de', 'en', 'ms', 'zh'].flatMap((locale) => [
        `src/i18n/${locale}/notifications.json`,
        `src/i18n/${locale}/documents.json`,
      ]),
    ]) {
      mkdirSync(path.dirname(api(file)), { recursive: true });
      copyFileSync(path.join(REPO, 'apps/api', file), api(file));
    }
    await addFeature(root, {
      name: 'orders',
      fields: 'title:string,total:money',
    });
    // The table as a migration made it: what the guard compares with.
    mkdirSync(api('drizzle/meta'), { recursive: true });
    writeFileSync(
      api('drizzle/meta/_journal.json'),
      JSON.stringify({ entries: [{ idx: 0 }] }),
    );
    const column = (notNull) => ({ notNull });
    writeFileSync(
      api('drizzle/meta/0000_snapshot.json'),
      JSON.stringify({
        tables: {
          'public.orders': {
            columns: {
              id: column(true),
              tenant_id: column(true),
              owner_id: column(true),
              title: column(true),
              total_minor: column(true),
              total_currency: column(true),
              created_at: column(true),
              updated_at: column(true),
              deleted_at: column(false),
              deleted_by: column(false),
            },
          },
        },
      }),
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('reads the declaration the generator wrote', () => {
    const read = readRecord(record());
    assert.equal(read.subject, 'Order');
    assert.equal(read.table, 'orders');
    assert.deepEqual(
      read.fields.map((f) => [f.name, f.type]),
      [
        ['title', 'string'],
        ['total', 'money'],
      ],
    );
    assert.equal(read.capabilities.size, 0);
  });

  it('refuses a new required field without a default, takes one with', () => {
    edit(
      '    total: field.money(),\n',
      '    total: field.money(),\n    dueOn: field.date(),\n',
    );
    assert.match(
      syncFeature(api(), 'orders').errors.join('\n'),
      /orders\.dueOn: a new required field/,
    );
    edit(
      '    dueOn: field.date(),\n',
      '    dueOn: field.date().optional(),\n    rank: field.int().default(1),\n',
    );
    const result = syncFeature(api(), 'orders');
    assert.deepEqual(result.errors, []);
    assert.equal(result.generate, true);
  });

  it('refuses a removed field (expand/contract)', () => {
    edit('    title: field.string(),\n', '');
    assert.match(
      syncFeature(api(), 'orders').errors.join('\n'),
      /the column title has no field any more/,
    );
    edit('  fields: {\n', '  fields: {\n    title: field.string(),\n');
  });

  it("adds a capability's paths and texts, and takes them away when it goes", () => {
    edit('  capabilities: [],', "  capabilities: ['comments', 'watch'],");
    const added = syncFeature(api(), 'orders');
    assert.ok(
      added.changes.includes('OpenAPI test: + /v1/orders/{id}/comments'),
    );
    assert.ok(added.changes.includes('en/notifications.json: + order'));
    assert.equal(
      syncFeature(api(), 'orders', { check: true }).changes.length,
      0,
    );
    edit(
      "  capabilities: ['comments', 'watch'],",
      "  capabilities: ['watch'],",
    );
    const removed = syncFeature(api(), 'orders');
    assert.ok(
      removed.changes.includes('OpenAPI test: - /v1/orders/{id}/comments'),
    );
  });
});
