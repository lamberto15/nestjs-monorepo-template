import { usePeopleNames } from '@/lib/people';

const USER_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * A comment's text with its mentions marked (docs/comments.md: `@address` or
 * `@user:<id>`). The body is plain text: it goes into React text nodes, never
 * into HTML, so nothing in it can inject markup. Only the pieces matching a
 * mention are wrapped, and the text of `@user:<id>` becomes the person's name
 * when it is known (`mentionNames`, by principal key `user:<id>`; see
 * `useMentionNames`), else (absent, or null: someone the tenant never had) the
 * raw mention stays.
 */
const MENTION = new RegExp(
  `@(?:user:${USER_ID}|[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+|\\[deleted\\])`,
  'gi',
);
/** Every `@user:<id>` of a text: what a comment box writes for a person. */
export const USER_MENTION = new RegExp(`@user:${USER_ID}`, 'gi');

export type Piece = { text: string; mention?: string };

/** The text split into plain pieces and mentions. */
export function splitMentions(
  body: string,
  names: Readonly<Record<string, string | null>> = {},
): Piece[] {
  const byKey = new Map(
    Object.entries(names).map(([key, name]) => [key.toLowerCase(), name]),
  );
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    if (match.index > last) {
      pieces.push({ text: body.slice(last, match.index) });
    }
    const raw = match[0];
    const key = raw.startsWith('@user:') ? raw.slice(1).toLowerCase() : null;
    const name = key ? byKey.get(key) : undefined;
    pieces.push({ text: name ? `@${name}` : raw, mention: raw });
    last = match.index + raw.length;
  }
  if (last < body.length) {
    pieces.push({ text: body.slice(last) });
  }
  return pieces;
}

/** At most this many people are mentioned in one comment (apps/api comments.service.ts). */
const MAX_MENTIONS = 20;

/**
 * The names for the `@user:<id>` mentions of a comment's body. The API names
 * the mentions it kept (`mentionNames`); one it dropped (the author's own, or
 * a person who may not read the record) has no entry, though the person is a
 * member whom every member may look up by key (`GET /v1/people?key=`,
 * docs/permissions.md, "The people directory"): those are asked for here,
 * batched and cached by `usePeopleNames`. A null entry (someone the tenant
 * never had) stays null, and a key nobody names stays without a name.
 */
export function useMentionNames(
  body: string,
  names: Readonly<Record<string, string | null>> = {},
): Readonly<Record<string, string | null>> {
  const known = new Set(Object.keys(names).map((key) => key.toLowerCase()));
  // Only the first ones: the API keeps no more (MAX_MENTIONS), and a body
  // of thousands of ids must not make every reader ask for thousands of names.
  const unnamed = userKeysOf(body)
    .slice(0, MAX_MENTIONS)
    .filter((key) => !known.has(key));
  const asked = usePeopleNames(unnamed);
  const found = Object.fromEntries(
    unnamed.flatMap((key) => {
      const name = asked.get(key);
      return name === undefined ? [] : [[key, name]];
    }),
  );
  return Object.keys(found).length === 0 ? names : { ...names, ...found };
}

/** The principal keys (`user:<id>`, lower-cased) a text mentions with `@user:<id>`. */
export function userKeysOf(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(USER_MENTION)].map((m) => m[0].slice(1).toLowerCase()),
    ),
  ];
}

export function CommentText(props: {
  body: string;
  /** The comment's `mentionNames`: `{ "user:<id>": name | null }`. */
  names?: Readonly<Record<string, string | null>>;
}) {
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {splitMentions(props.body, props.names).map((piece, index) =>
        piece.mention ? (
          <span
            key={index}
            data-mention={piece.mention}
            className="rounded bg-blue-200 px-0.5 py-px text-blue-950 dark:bg-blue-800 dark:text-blue-50"
          >
            {piece.text}
          </span>
        ) : (
          piece.text
        ),
      )}
    </p>
  );
}
