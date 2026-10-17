import type { Mentionable } from './users';

/**
 * A comment's text with its mentions marked (docs/comments.md: `@address` or
 * `@user:<id>`). The body is plain text: it goes into React text nodes, never
 * into HTML, so nothing in it can inject markup. Only the pieces matching a
 * mention are wrapped, and the text of `@user:<id>` becomes the person's name
 * when the directory knows it.
 */
const MENTION =
  /@(?:user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\[deleted\])/gi;

export type Piece = { text: string; mention?: string };

/** The text split into plain pieces and mentions. */
export function splitMentions(
  body: string,
  users: readonly Mentionable[] = [],
): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    if (match.index > last) {
      pieces.push({ text: body.slice(last, match.index) });
    }
    const raw = match[0];
    const id = raw.startsWith('@user:') ? raw.slice('@user:'.length) : null;
    const name = id ? users.find((user) => user.id === id)?.name : undefined;
    pieces.push({ text: name ? `@${name}` : raw, mention: raw });
    last = match.index + raw.length;
  }
  if (last < body.length) {
    pieces.push({ text: body.slice(last) });
  }
  return pieces;
}

export function CommentText(props: {
  body: string;
  users?: readonly Mentionable[];
}) {
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {splitMentions(props.body, props.users).map((piece, index) =>
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
