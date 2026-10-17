import type { ReactNode } from 'react';

export type SnippetPart = { text: string; bold: boolean };

/**
 * The search snippet (`GET /v1/search`) marks matches with `<b>…</b>`. Only
 * those two tags are understood; every other character, `<img onerror=…>` and
 * `<script>` included, stays text. Nothing is ever parsed as HTML, so there
 * is no dangerouslySetInnerHTML: a custom parser because no NestJS or
 * React facility renders a restricted markup.
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let bold = false;
  for (const piece of snippet.split(/(<\/?b>)/i)) {
    if (/^<b>$/i.test(piece)) {
      bold = true;
    } else if (/^<\/b>$/i.test(piece)) {
      bold = false;
    } else if (piece) {
      parts.push({ text: piece, bold });
    }
  }
  return parts;
}

/** A snippet as React elements: `<b>` becomes <mark>, the rest is text. */
export function Snippet(props: { value: string }): ReactNode {
  return parseSnippet(props.value).map((part, index) =>
    part.bold ? (
      <mark
        key={index}
        className="rounded-sm bg-transparent font-semibold text-foreground"
      >
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
