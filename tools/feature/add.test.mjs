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
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { addFeature, MARKERS } from './add.mjs';
import { parseCapabilities } from './capabilities.mjs';
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
      'src/features/notes/notes.tables.ts',
      ...['ar', 'de', 'en', 'ms', 'zh'].flatMap((locale) => [
        `src/i18n/${locale}/notifications.json`,
        `src/i18n/${locale}/documents.json`,
      ]),
    ]) {
      mkdirSync(path.dirname(api(file)), { recursive: true });
      copyFileSync(path.join(REPO, 'apps/api', file), api(file));
    }
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
    assert.equal(result.changed.length, 3);

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

  it("refuses a reference to a table others can't point at", async () => {
    await assert.rejects(
      addFeature(root, { name: 'receipts', fields: 'noteId:ref(notes)?' }),
      /referenced: true/,
    );
    await assert.rejects(
      addFeature(root, { name: 'tenants', fields: 'title:string' }),
      /taken/,
    );
  });
});
