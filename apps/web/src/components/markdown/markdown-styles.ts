/**
 * How Markdown looks, in the editor (ProseMirror's DOM) and on a detail page
 * (react-markdown's): the same element rules, so what is typed is what is
 * read. Tailwind's preflight strips lists, headings and quotes; the rules
 * give them back without a typography plugin.
 */
export const markdownStyles = [
  'break-words',
  '[&>*+*]:mt-3',
  '[&_h1]:text-xl [&_h1]:font-semibold',
  '[&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:text-base [&_h3]:font-semibold',
  '[&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold',
  '[&_ul]:list-disc [&_ul]:ps-6 [&_ol]:list-decimal [&_ol]:ps-6',
  '[&_li_p]:my-0 [&_li>*+*]:mt-1',
  '[&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
  '[&_hr]:border-border',
].join(' ');
