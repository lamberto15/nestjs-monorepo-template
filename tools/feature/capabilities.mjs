// What `--with …` means to the generator (tools/feature/add.mjs): the
// capabilities' names and the texts they need in every locale (their tests
// are apps/api/test/record-capabilities.ts). The capabilities themselves are the
// platform's (platform/records: generic targets and routes), declared in
// the feature's `<item>.record.ts`.

import { pascalOf } from './fields.mjs';

export const CAPABILITIES = [
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'bulk',
  'watch',
  'search',
  'transfer',
  'custom',
];

/** `--with tags,comments`: the capabilities, checked; pdf brings attachments (a PDF is one). */
export function parseCapabilities(list, fields) {
  const wanted = new Set(
    (list ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  for (const name of wanted) {
    if (!CAPABILITIES.includes(name)) {
      throw new Error(
        `--with: "${name}" is not a capability; any of ${CAPABILITIES.join(', ')}.`,
      );
    }
  }
  if (wanted.has('pdf')) {
    wanted.add('attachments');
  }
  if (wanted.has('search') && !textFields(fields).length) {
    throw new Error(
      '--with search: the feature needs a string or text field to search.',
    );
  }
  return wanted;
}

const textFields = (fields) =>
  fields.filter((f) => f.type === 'string' || f.type === 'text');
/** The field a record is called by (comments, search, PDF): its first string, if any. */
export const titleField = (fields) =>
  fields.find((f) => f.type === 'string') ?? null;
/** `invoiceLine`: notification types, i18n keys, audit actions. */
export const lowerFirst = (word) => word[0].toLowerCase() + word.slice(1);

/**
 * The texts the capabilities need, by namespace and key path (English; the
 * other locales get the same until translated: add.mjs lists them).
 */
export function texts({ t, fields, has }) {
  const lc = lowerFirst(t.Singular);
  const out = {};
  if (has('comments')) {
    out.notifications = {
      [lc]: {
        commented: {
          label: `Comment on ${t.aNoun} you watch`,
          title: 'New comment',
          body: {
            one: '{by} commented on "{title}": {excerpt}',
            other:
              '{count} new comments on "{title}"; the latest by {by}: {excerpt}',
          },
        },
      },
    };
  }
  if (has('pdf')) {
    out.documents = {
      [lc]: {
        document: pascalOf(t.noun),
        issued: 'Issued {date}',
        fields: Object.fromEntries(
          fields
            .filter((f) => f.type !== 'json')
            .map((f) => [f.name, words(f.name)]),
        ),
      },
    };
  }
  return out;
}

/** `dueOn` → `Due on`: a label. */
const words = (camelName) => {
  const spaced = camelName.replace(
    /[A-Z]/g,
    (letter) => ` ${letter.toLowerCase()}`,
  );
  return spaced[0].toUpperCase() + spaced.slice(1);
};
