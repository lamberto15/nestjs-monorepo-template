import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nestjs-monorepo-template/ui/components/popover';
import { Toggle } from '@nestjs-monorepo-template/ui/components/toggle';
import { cn } from '@nestjs-monorepo-template/ui/lib/utils';
import { Markdown } from '@tiptap/markdown';
import {
  Editor as TiptapEditor,
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  StrikethroughIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { markdownStyles } from './markdown-styles';
import { isSafeUrl } from './safe-url';

// Tiptap (https://tiptap.dev) with its official Markdown extension: the
// document is ProseMirror's, the value in and out is a Markdown string. Only
// what Markdown can say is on: StarterKit's underline has no Markdown form and
// would be lost on the way out, so it is off.
const extensions = [
  StarterKit.configure({
    underline: false,
    heading: { levels: [2, 3] },
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      // Same rule as the viewer's: web addresses and mail.
      isAllowedUri: (url) => isSafeUrl(url),
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    },
  }),
  // A single newline is a line break, as the viewer renders it.
  Markdown.configure({ markedOptions: { breaks: true } }),
];

function useActive(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      heading: current.isActive('heading', { level: 2 }),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      blockquote: current.isActive('blockquote'),
      link: current.isActive('link'),
      // Nothing selected and not on a link: there is no text to link.
      canLink: !current.state.selection.empty || current.isActive('link'),
    }),
  });
}

function ToolbarToggle(props: {
  label: string;
  pressed: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Toggle
      size="sm"
      aria-label={props.label}
      title={props.label}
      pressed={props.pressed}
      // The editor keeps the selection: a click on the bar must not take the focus.
      onMouseDown={(event) => event.preventDefault()}
      onPressedChange={props.onPress}
    >
      {props.children}
    </Toggle>
  );
}

function LinkButton(props: {
  editor: Editor;
  active: boolean;
  canLink: boolean;
}) {
  const { editor, active } = props;
  const { t } = useTranslation('markdown');
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const invalid = url !== '' && !isSafeUrl(url);

  const apply = () => {
    if (url === '') editor.chain().focus().unsetLink().run();
    else if (isSafeUrl(url)) {
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href: url })
        .run();
    } else return;
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setUrl(editor.getAttributes('link').href ?? '');
        setOpen(next);
      }}
    >
      <PopoverTrigger
        disabled={!props.canLink}
        render={
          <Toggle
            size="sm"
            aria-label={t('link')}
            title={t('link')}
            pressed={props.active}
            onPressedChange={() => {}}
          />
        }
        onMouseDown={(event) => event.preventDefault()}
      >
        <LinkIcon />
      </PopoverTrigger>
      <PopoverContent align="start">
        <Input
          type="url"
          inputMode="url"
          autoFocus
          aria-label={t('linkUrl')}
          aria-invalid={invalid}
          placeholder="https://"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            // Not the note form's submit: this input is the link's.
            if (event.key === 'Enter') {
              event.preventDefault();
              apply();
            }
          }}
        />
        {invalid && (
          <p role="alert" className="text-xs text-destructive">
            {t('linkInvalid')}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={apply} disabled={invalid}>
            {t('linkApply')}
          </Button>
          {active && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                editor
                  .chain()
                  .focus()
                  .extendMarkRange('link')
                  .unsetLink()
                  .run();
                setOpen(false);
              }}
            >
              {t('linkRemove')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const { t } = useTranslation('markdown');
  const active = useActive(editor);
  const run = () => editor.chain().focus();
  return (
    <div
      role="toolbar"
      aria-label={t('toolbar')}
      className="flex flex-wrap items-center gap-0.5 border-b p-1"
    >
      <ToolbarToggle
        label={t('bold')}
        pressed={active.bold}
        onPress={() => run().toggleBold().run()}
      >
        <BoldIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('italic')}
        pressed={active.italic}
        onPress={() => run().toggleItalic().run()}
      >
        <ItalicIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('strike')}
        pressed={active.strike}
        onPress={() => run().toggleStrike().run()}
      >
        <StrikethroughIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('code')}
        pressed={active.code}
        onPress={() => run().toggleCode().run()}
      >
        <CodeIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('heading')}
        pressed={active.heading}
        onPress={() => run().toggleHeading({ level: 2 }).run()}
      >
        <Heading2Icon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('bulletList')}
        pressed={active.bulletList}
        onPress={() => run().toggleBulletList().run()}
      >
        <ListIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('orderedList')}
        pressed={active.orderedList}
        onPress={() => run().toggleOrderedList().run()}
      >
        <ListOrderedIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label={t('quote')}
        pressed={active.blockquote}
        onPress={() => run().toggleBlockquote().run()}
      >
        <QuoteIcon />
      </ToolbarToggle>
      <LinkButton
        editor={editor}
        active={active.link}
        canLink={active.canLink}
      />
    </div>
  );
}

/**
 * The editor itself. `value` is read once, when it mounts (the form that
 * holds it is remounted for a new version); `onChange` gets the Markdown
 * after every edit, and not before one, so a body nobody touched is not
 * rewritten into the editor's own spelling.
 */
function RichEditor(props: {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const attributes = {
    ...(props.id && { id: props.id }),
    role: 'textbox',
    'aria-multiline': 'true',
    ...(props.labelledBy && { 'aria-labelledby': props.labelledBy }),
    ...(props.describedBy && { 'aria-describedby': props.describedBy }),
    'aria-invalid': String(Boolean(props.invalid)),
    class: 'min-h-40 px-3 py-2 outline-none ' + markdownStyles,
  };
  const editor = useEditor({
    extensions,
    content: props.value,
    contentType: 'markdown',
    editorProps: { attributes },
    // The serializer ends a list or a block with blank lines: not part of the text.
    onUpdate: ({ editor: current }) =>
      props.onChange(current.getMarkdown().trimEnd()),
    onBlur: () => props.onBlur?.(),
  });
  // aria-invalid and aria-describedby follow the field after the first render.
  const { id, labelledBy, describedBy, invalid } = props;
  useEffect(() => {
    editor?.setOptions({ editorProps: { attributes } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, id, labelledBy, describedBy, invalid]);

  if (!editor) return null;
  return (
    <div
      className={cn(
        'rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        props.invalid &&
          'border-destructive focus-within:border-destructive focus-within:ring-destructive/20',
      )}
      data-slot="markdown-editor"
    >
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

/** Line ends, trailing spaces and trailing blank lines are spelling, not content. */
function normalized(markdown: string) {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

/**
 * Whether the editor keeps every character of this Markdown: the text is
 * parsed and written back, and must come out as it went in. The schema has no
 * place for some things (a `<name>` placeholder, an image, raw HTML, a table),
 * and the first keystroke would write the document back without them.
 */
export function keepsMarkdown(markdown: string) {
  const probe = new TiptapEditor({
    extensions,
    content: markdown,
    contentType: 'markdown',
  });
  try {
    return normalized(probe.getMarkdown()) === normalized(markdown);
  } finally {
    probe.destroy();
  }
}

/**
 * A rich text editor whose value is Markdown, or, for a text it can't keep
 * whole (see `keepsMarkdown`), the plain textarea with a notice: nothing is
 * lost by opening a note.
 */
export function MarkdownEditor(props: {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation('markdown');
  // Decided once, with the text the form opened with.
  const [keeps] = useState(() => keepsMarkdown(props.value));
  const noticeId = useId();
  if (keeps) return <RichEditor {...props} />;
  return (
    <>
      <Textarea
        id={props.id}
        rows={8}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onBlur}
        aria-labelledby={props.labelledBy}
        aria-describedby={[noticeId, props.describedBy]
          .filter(Boolean)
          .join(' ')}
        aria-invalid={props.invalid}
      />
      <p id={noticeId} role="status" className="text-xs text-muted-foreground">
        {t('plainOnly')}
      </p>
    </>
  );
}
