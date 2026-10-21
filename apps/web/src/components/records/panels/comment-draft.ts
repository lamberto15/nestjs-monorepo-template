import { USER_MENTION, userKeysOf } from './comment-text';

/**
 * A comment box shows a mention as the person's name (`@Maya Patel`); the API
 * reads `@user:<id>` (docs/comments.md). `Picked` says whom each label in the
 * box stands for: principal key (`user:<id>`) to the label written for them.
 * The box's text turns into the API's with `toBody`, and an existing body
 * into the box's with `toDraft`.
 */
export type Picked = Readonly<Record<string, string>>;

/**
 * The label to write for a person: their name, or, when another person in
 * `used` (key to name or label) has that, the name with the end of their id
 * after it, as long as it takes to be nobody else's. Labels are what `toBody`
 * turns back into ids, so two people are never given the same one.
 */
export function labelFor(
  key: string,
  name: string,
  used: ReadonlyMap<string, string>,
): string {
  const taken = (label: string) =>
    [...used].some(([other, text]) => other !== key && text === label);
  if (!taken(name)) {
    return name;
  }
  for (let length = 4; ; length++) {
    const label = `${name} (${key.slice(-length)})`;
    if (!taken(label) || length >= key.length) {
      return label;
    }
  }
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The API's text for the box's: each `@label` of a picked person becomes
 * `@user:<id>`. Only whole labels at the start of a word count (the longest
 * first: "Maya Patel" before "Maya"), so a name merely typed by hand, or cut
 * short by an edit, stays the text it is.
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
  const label = new RegExp(
    `(?<!\\S)@(${labels.join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  return text.replace(label, (_, found: string) => `@${keyOf.get(found)}`);
}

/**
 * The box's text for an existing body (an edit): each `@user:<id>` that has a
 * name becomes `@Name`, the others (no name known) stay as written.
 */
export function toDraft(
  body: string,
  names: Readonly<Record<string, string | null>> = {},
): { text: string; picked: Picked } {
  const byKey = new Map(
    Object.entries(names).map(([key, name]) => [key.toLowerCase(), name]),
  );
  const named = new Map(
    userKeysOf(body).flatMap((key) => {
      const name = byKey.get(key);
      return name ? [[key, name] as const] : [];
    }),
  );
  const picked = Object.fromEntries(
    [...named].map(([key, name]) => [key, labelFor(key, name, named)]),
  );
  const text = body.replace(USER_MENTION, (raw) => {
    const label = picked[raw.slice(1).toLowerCase()];
    return label ? `@${label}` : raw;
  });
  return { text, picked };
}
