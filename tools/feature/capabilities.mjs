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
  'events',
  'numbered',
  'share',
  'automation',
  'merge',
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

/** The values `--idempotency`, `--client-access` and `--grants` take (record.ts); the first of each is what's unset. */
export const CHOICES = {
  idempotency: ['required', 'optional', 'off'],
  clientAccess: ['own'],
  grants: ['none'],
};

/**
 * The per-feature choices of the options, checked: `idempotency` (unset:
 * follow the deployment's IDEMPOTENCY), `clientAccess` ('own', else false:
 * API keys can't use the feature) and `grants` ('none', else 'standard').
 */
export function parseChoices({ idempotency, clientAccess, grants }) {
  const check = (flag, name, value) => {
    if (value !== undefined && !CHOICES[name].includes(value)) {
      throw new Error(
        `--${flag}: "${value}" is not a choice; any of ${CHOICES[name].join(', ')}.`,
      );
    }
    return value;
  };
  return {
    idempotency: check('idempotency', 'idempotency', idempotency),
    clientAccess: check('client-access', 'clientAccess', clientAccess) ?? false,
    grants: check('grants', 'grants', grants) ?? 'standard',
  };
}

/** The words an approval's action can't be: the record's own routes (platform/records/record-approvals.ts). */
export const RESERVED_ACTIONS = [
  'restore',
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'watch',
  'bulk',
  'shares',
  'merge',
  'duplicates',
];

/** `--approvals publish,markPaid`: the actions that need approval, checked. */
export function parseApprovals(list) {
  const actions = (list ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const action of actions) {
    if (
      !/^[a-z][a-zA-Z0-9]*$/.test(action) ||
      RESERVED_ACTIONS.includes(action)
    ) {
      throw new Error(
        `--approvals: "${action}" is not an action; a camelCase word (publish, markPaid), none of ${RESERVED_ACTIONS.join(', ')}.`,
      );
    }
  }
  if (new Set(actions).size !== actions.length) {
    throw new Error('--approvals: an action is named twice.');
  }
  return actions;
}

/** `Publish an invoice`: an approval's label in the inbox. */
export const approvalLabel = (action, t) => {
  const spaced = action.replace(
    /[A-Z]/g,
    (letter) => ` ${letter.toLowerCase()}`,
  );
  return `${spaced[0].toUpperCase()}${spaced.slice(1)} ${t.aNoun}`;
};

/**
 * `--settings "paymentDays:int=30,autoSend:flag,tone:enum(formal|casual)=formal,footer:string=Thanks"`:
 * name, kind (`flag`, `int`, `string`, `enum(a|b)`) and default (a flag's is
 * false; an `int` needs one; a string's is empty; an enum's its first value).
 * Returns each as the `recordSetting` call the declaration holds.
 */
export function parseSettings(list, approvals = []) {
  const entries = [];
  // Commas separate settings; an enum's values use `|`, so no comma is inside one.
  for (const raw of (list ?? '').split(',')) {
    const text = raw.trim();
    if (!text) continue;
    const match = /^(\w+):(flag|int|string|enum\(([^)]*)\))(?:=(.*))?$/.exec(
      text,
    );
    if (!match) {
      throw new Error(
        `--settings: "${text}" is not name:kind[=default]; kinds flag, int, string, enum(a|b).`,
      );
    }
    // A group that did not take part (no `=default`, not an enum) is undefined.
    const [, name, kindText, enumValues, initial] =
      /** @type {(string | undefined)[]} */ (match);
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
      throw new Error(`--settings: "${name}" is not a camelCase name.`);
    }
    if (approvals.some((action) => `${action}Approval` === name)) {
      throw new Error(
        `--settings: "${name}" is the flag of the approval of ${name.replace(/Approval$/, '')} (record.ts derives it).`,
      );
    }
    const kind = kindText.startsWith('enum') ? 'enum' : kindText;
    let call;
    if (kind === 'flag') {
      if (initial !== undefined && !['true', 'false'].includes(initial)) {
        throw new Error(
          `--settings ${name}: a flag's default is true or false.`,
        );
      }
      call = `recordSetting.flag(${initial === 'true' ? 'true' : ''})`;
    } else if (kind === 'int') {
      if (initial === undefined || !/^-?\d+$/.test(initial)) {
        throw new Error(
          `--settings ${name}: an int needs a default (${name}:int=30).`,
        );
      }
      call = `recordSetting.int(${initial})`;
    } else if (kind === 'string') {
      call = `recordSetting.string(${JSON.stringify(initial ?? '').replace(/^"|"$/g, "'")})`;
      if (/['\\]/.test(initial ?? '')) {
        throw new Error(
          `--settings ${name}: no quotes or backslashes in a default.`,
        );
      }
    } else {
      const values = enumValues.split('|').map((v) => v.trim());
      if (values.length < 2 || values.some((v) => !/^[\w-]+$/.test(v))) {
        throw new Error(
          `--settings ${name}: enum needs two or more words (enum(a|b)).`,
        );
      }
      const chosen = initial ?? values[0];
      if (!values.includes(chosen)) {
        throw new Error(
          `--settings ${name}: the default is not one of its values.`,
        );
      }
      call = `recordSetting.enum([${values.map((v) => `'${v}'`).join(', ')}], '${chosen}')`;
    }
    if (entries.some((entry) => entry.name === name)) {
      throw new Error(`--settings: "${name}" twice.`);
    }
    entries.push({ name, call });
  }
  return entries;
}

const textFields = (fields) =>
  fields.filter((f) => f.type === 'string' || f.type === 'text');
/** The field a record is called by (comments, search, PDF): its first string, if any. */
export const titleField = (fields) =>
  fields.find((f) => f.type === 'string') ?? null;
/** The prefix of a record's numbers: its subject's initials (`InvoiceLine` → `IL`), or its first three letters (`INV`); as platform/records/record.ts's `numberFormat`. */
export const numberPrefix = (subject) => {
  const words = subject.match(/[A-Z][a-z0-9]*/g) ?? [subject];
  return (
    words.length > 1 ? words.map((w) => w[0]).join('') : subject.slice(0, 3)
  ).toUpperCase();
};
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
        fields: {
          ...(has('numbered') && { number: 'Number' }),
          ...Object.fromEntries(
            fields
              .filter((f) => f.type !== 'json')
              .map((f) => [f.name, words(f.name)]),
          ),
        },
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
