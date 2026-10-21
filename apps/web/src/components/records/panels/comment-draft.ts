import { USER_MENTION } from './comment-text';

/**
 * Where a mention may stand: after anything but a word character, "@" or "."
 * (the API's own rule, comments.service.ts: `(@ada)` and `"@ada"` count,
 * `ada@example.com` does not), and before anything that would make it part
 * of a longer word or address (`@Sam` in `@Sam.Jones@corp.com`). `toBody` and
 * `toDraft` share it, so a body read into the box and sent back is unchanged.
 */
const BEFORE = '(?<![\\w@.])';
const AFTER = '(?![\\p{L}\\p{N}_@]|[.+-][\\p{L}\\p{N}])';

/**
 * A comment box shows a mention as the person's name (`@Maya Patel`); the API
 * reads `@user:<id>` (docs/comments.md). `Picked` says whom each label in the
 * box stands for: principal key (`user:<id>`) to the label written for them.
 * The box's text turns into the API's with `toBody`, and an existing body
 * into the box's with `toDraft`.
 */
export type Picked = Readonly<Record<string, string>>;

/** The input holds one line: a name's line breaks and runs of spaces become one space. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The label to write for a person: their name (on one line), or, when another
 * person in `used` (key to name or label) has that, the name with the end of
 * their id after it, as long as it takes to be nobody else's. Labels are what
 * `toBody` turns back into ids, so two people are never given the same one.
 */
export function labelFor(
  key: string,
  name: string,
  used: ReadonlyMap<string, string>,
): string {
  const label = oneLine(name);
  const taken = (candidate: string) =>
    [...used].some(
      ([other, text]) => other !== key && oneLine(text) === candidate,
    );
  if (!taken(label)) {
    return label;
  }
  for (let length = 4; ; length++) {
    const suffixed = `${label} (${key.slice(-length)})`;
    if (!taken(suffixed) || length >= key.length) {
      return suffixed;
    }
  }
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The API's text for the box's: each `@label` of a picked person becomes
 * `@user:<id>`. Only whole labels where a mention may stand count (the
 * longest first: "Maya Patel" before "Maya"), so a name merely typed by
 * hand, or cut short by an edit, stays the text it is.
 */
export function toBody(text: string, picked: Picked): string {
  const keyOf = new Map(
    Object.entries(picked).map(([key, label]) => [label, key]),
  );
  if (keyOf.size === 0) {
    return text;
  }
  const labels = [...keyOf.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const label = new RegExp(`${BEFORE}@(${labels.join('|')})${AFTER}`, 'gu');
  return text.replace(label, (_, found: string) => `@${keyOf.get(found)}`);
}

/**
 * The box's text for an existing body (an edit): each `@user:<id>` that has a
 * name, and stands where `toBody` would turn the name back into it, becomes
 * `@Name`; the others (no name known, or a place a label would not survive)
 * stay as written, which the API reads as before.
 */
export function toDraft(
  body: string,
  names: Readonly<Record<string, string | null>> = {},
): { text: string; picked: Picked } {
  const mention = new RegExp(`${BEFORE}${USER_MENTION.source}${AFTER}`, 'giu');
  const byKey = new Map(
    Object.entries(names).map(([key, name]) => [key.toLowerCase(), name]),
  );
  const named = new Map(
    [...body.matchAll(mention)].flatMap((found) => {
      const key = found[0].slice(1).toLowerCase();
      const name = byKey.get(key);
      return name ? [[key, name] as const] : [];
    }),
  );
  const picked = Object.fromEntries(
    [...named].map(([key, name]) => [key, labelFor(key, name, named)]),
  );
  const text = body.replace(mention, (raw) => {
    const label = picked[raw.slice(1).toLowerCase()];
    return label ? `@${label}` : raw;
  });
  return { text, picked };
}
