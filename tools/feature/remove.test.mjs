// The feature remover's tests (tools/feature/remove.mjs):
//   node --test tools/feature/remove.test.mjs
// They add features to a scratch copy of the files the tools touch, then
// remove them; the real tree is never written.
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
import { addFeature } from './add.mjs';
import { removeFeature } from './remove.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const LOCALES = ['ar', 'de', 'en', 'ms', 'zh'];

describe('removeFeature', () => {
  let root;
  const api = (...parts) => path.join(root, 'apps/api', ...parts);
  const read = (file) => readFileSync(file, 'utf8');

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'feature-remove-'));
    copyFileSync(
      path.join(REPO, '.prettierrc'),
      path.join(root, '.prettierrc'),
    );
    for (const file of [
      'src/features/index.ts',
      'src/features/tables.ts',
      'test/openapi.e2e-spec.ts',
      'src/features/notes/notes.tables.ts',
      ...LOCALES.flatMap((locale) => [
        `src/i18n/${locale}/notifications.json`,
        `src/i18n/${locale}/documents.json`,
      ]),
    ]) {
      mkdirSync(path.dirname(api(file)), { recursive: true });
      copyFileSync(path.join(REPO, 'apps/api', file), api(file));
    }
    // features/env.ts as a project with one feature's variables has it.
    writeFileSync(
      api('src/features/env.ts'),
      `import { z } from 'zod';
import { invoicesEnv } from './invoices/invoices.env.js';
import { notesEnv } from './notes/notes.env.js';

export const featuresEnv = z.object({
  ...invoicesEnv.shape,
  ...notesEnv.shape,
});
`,
    );
    writeFileSync(
      path.join(root, 'env.example'),
      `A=1

# feature:invoices begin
# Invoices.
INVOICE_DELAY=10s
# feature:invoices end

B=2

# feature:invoices begin
INVOICE_SECRET_FILE=
# feature:invoices end
C=3
`,
    );
    mkdirSync(path.join(root, 'apps/api/test'), { recursive: true });
    writeFileSync(
      path.join(root, 'apps/api/test/setup-env.ts'),
      `Object.assign(process.env, {
  A: '1',
  // feature:invoices begin
  INVOICE_DELAY: '10s',
  // feature:invoices end
  B: '2',
});
`,
    );
    await addFeature(root, {
      name: 'invoices',
      fields: 'title:string,total:money',
    });
    await addFeature(root, {
      name: 'payments',
      fields: 'amount:money,invoiceId:ref(invoices)?',
    });
    mkdirSync(api('src/documents/templates'), { recursive: true });
    writeFileSync(api('src/documents/templates/invoice.html'), '<p></p>');
    mkdirSync(api('test/features/invoices'), { recursive: true });
    writeFileSync(api('test/features/invoices/x.ts'), '');
    writeFileSync(api('src/features/invoices/invoices.env.ts'), '');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('refuses an unknown feature', () => {
    assert.throws(
      () => removeFeature(root, { name: 'ghosts' }),
      /no features\/ghosts/,
    );
  });

  it('refuses while another feature refers to it, and lists the files', () => {
    // Payments has a ref(invoices) field.
    assert.throws(
      () => removeFeature(root, { name: 'invoices' }),
      /payment\.record\.ts/,
    );
    assert.ok(existsSync(api('src/features/invoices')));
  });

  it('removes the referring feature first, leaving the rest alone', () => {
    removeFeature(root, { name: 'payments' });
    assert.ok(!existsSync(api('src/features/payments')));
    assert.ok(!read(api('src/features/index.ts')).includes('PAYMENTS'));
    assert.ok(read(api('src/features/tables.ts')).includes('notes.tables'));
  });

  it('changes nothing on a dry run', () => {
    const before = read(api('src/features/index.ts'));
    const result = removeFeature(root, { name: 'invoices', dryRun: true });
    assert.equal(result.item, 'invoice');
    assert.ok(result.deleted.includes('apps/api/src/features/invoices'));
    assert.equal(read(api('src/features/index.ts')), before);
    assert.ok(existsSync(api('src/features/invoices')));
    assert.ok(read(path.join(root, 'env.example')).includes('INVOICE_DELAY'));
  });

  it('removes the folder, tests, lines, texts, template and env blocks', () => {
    const result = removeFeature(root, { name: 'invoices' });
    assert.ok(!existsSync(api('src/features/invoices')));
    assert.ok(!existsSync(api('test/invoices.e2e-spec.ts')));
    assert.ok(!existsSync(api('test/features/invoices')));
    assert.ok(!existsSync(api('src/documents/templates/invoice.html')));
    assert.ok(result.removed.some((r) => r.includes('env.example')));

    const index = read(api('src/features/index.ts'));
    assert.ok(!index.includes('INVOICES_FEATURE'));
    assert.ok(index.includes('NOTES_FEATURE,'));
    assert.ok(index.includes('// pnpm feature:add: features above this line.'));
    assert.ok(!read(api('src/features/tables.ts')).includes('invoices'));
    const env = read(api('src/features/env.ts'));
    assert.ok(!env.includes('invoicesEnv'));
    assert.ok(env.includes('...notesEnv.shape,'));

    for (const locale of LOCALES) {
      for (const file of ['notifications', 'documents']) {
        const text = read(api(`src/i18n/${locale}/${file}.json`));
        assert.ok(!('invoice' in JSON.parse(text)), `${locale}/${file}`);
        assert.ok(text.endsWith('}\n'));
        assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
      }
    }
    assert.equal(read(path.join(root, 'env.example')), 'A=1\n\nB=2\n\nC=3\n');
    assert.equal(
      read(path.join(root, 'apps/api/test/setup-env.ts')),
      "Object.assign(process.env, {\n  A: '1',\n  B: '2',\n});\n",
    );
  });
});
