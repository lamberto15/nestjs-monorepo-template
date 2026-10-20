import type { ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { cn } from '@nestjs-monorepo-template/ui/lib/utils';
import { isSafeUrl } from './safe-url';
import { markdownStyles } from './markdown-styles';

// What a body may contain once rendered. Nothing else is output: no images
// (a remote one tells its host who read the note), no tables, no raw HTML.
const ALLOWED = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'a',
];

function Link({ href, children }: ComponentProps<'a'> & { node?: unknown }) {
  // urlTransform already emptied an unsafe address: show the text alone.
  if (!isSafeUrl(href)) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * A Markdown body (docs/monorepo.md, "The web app"). react-markdown builds
 * React elements, never an HTML string, and without rehype-raw the HTML in a
 * body is shown as text, not run. On top: only the elements above, links
 * only http(s) and mailto (anything else is dropped by `urlTransform`),
 * every link `rel="noopener noreferrer"`. `remark-breaks` keeps a single
 * line break a line break, so a plain-text body reads as it did.
 */
export function MarkdownView(props: { children: string; className?: string }) {
  return (
    <div className={cn(markdownStyles, props.className)}>
      <Markdown
        remarkPlugins={[remarkBreaks]}
        allowedElements={ALLOWED}
        unwrapDisallowed
        urlTransform={(url) => (isSafeUrl(url) ? url : '')}
        components={{ a: Link }}
      >
        {props.children}
      </Markdown>
    </div>
  );
}
