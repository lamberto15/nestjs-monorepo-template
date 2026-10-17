// A feature's name in every form the generated files use (tools/feature/add.mjs).
// Given plural and kebab-case (`invoice-lines`), as docs/adding-a-feature.md
// names features: plural for the module, tables, service and controller,
// singular for what is about one record.

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** `invoice-lines` → `invoice-line`; null when it doesn't look plural. */
export function singularize(plural) {
  if (/(ss|us|is)$/.test(plural)) {
    return null; // `address`, `status`, `analysis`: give --singular
  }
  if (/[^aeiou]ies$/.test(plural)) {
    return plural.replace(/ies$/, 'y');
  }
  if (/(ches|shes|xes|zes|sses)$/.test(plural)) {
    return plural.replace(/es$/, '');
  }
  if (/s$/.test(plural)) {
    return plural.replace(/s$/, '');
  }
  return null;
}

const words = (kebab) => kebab.split('-');
const capital = (word) => word[0].toUpperCase() + word.slice(1);
const camel = (kebab) =>
  words(kebab)
    .map((word, i) => (i === 0 ? word : capital(word)))
    .join('');
const pascal = (kebab) => words(kebab).map(capital).join('');

/**
 * Every form of a feature's name. Throws with what to do when the name
 * isn't plural kebab-case, or its singular can't be derived.
 */
export function names(plural, singularOverride) {
  if (!KEBAB.test(plural)) {
    throw new Error(
      `"${plural}": a feature's name is plural, lowercase words joined by "-" (invoices, invoice-lines).`,
    );
  }
  const singular = singularOverride ?? singularize(plural);
  if (!singular || singular === plural) {
    throw new Error(
      `"${plural}": its singular can't be derived; give it with --singular.`,
    );
  }
  if (!KEBAB.test(singular)) {
    throw new Error(`--singular "${singular}": lowercase words joined by "-".`);
  }
  return {
    plural, // invoice-lines: the folder, the plural files, the URL path
    singular, // invoice-line: the single-record files
    pluralCamel: camel(plural), // invoiceLines: the table's constant
    singularCamel: camel(singular), // invoiceLine
    Plural: pascal(plural), // InvoiceLines: module, service, controller
    Singular: pascal(singular), // InvoiceLine: the permission subject
    PLURAL: words(plural).join('_').toUpperCase(), // INVOICE_LINES
    SINGULAR: words(singular).join('_').toUpperCase(), // INVOICE_LINE
    table: words(plural).join('_'), // invoice_lines: the SQL table
    nouns: words(plural).join(' '), // invoice lines: prose
    noun: words(singular).join(' '), // invoice line
    aNoun: `${/^[aeiou]/.test(singular) ? 'an' : 'a'} ${words(singular).join(' ')}`,
  };
}

/** `dueOn` → `due_on`: a column's name. */
export const snake = (camelName) =>
  camelName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
