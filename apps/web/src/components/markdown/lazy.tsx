import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { lazy, Suspense } from 'react';

// The editor and the viewer are the heavy parts (ProseMirror, the Markdown
// parsers): each is its own chunk, fetched only when a page needs it, so the
// main bundle stays what it was.
const View = lazy(() =>
  import('./markdown-view').then((m) => ({ default: m.MarkdownView })),
);
const Editor = lazy(() =>
  import('./markdown-editor').then((m) => ({ default: m.MarkdownEditor })),
);

/** A Markdown body; until its chunk arrives, the text as written. */
export function MarkdownText(props: { children: string }) {
  return (
    <Suspense
      fallback={
        <p className="break-words whitespace-pre-wrap">{props.children}</p>
      }
    >
      <View>{props.children}</View>
    </Suspense>
  );
}

export function LazyMarkdownEditor(props: React.ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full" aria-hidden />}>
      <Editor {...props} />
    </Suspense>
  );
}
