import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { NOTE_ID, sampleNote, useNotesApi } from './test/notes-api';

const ALL = ['Note.read', 'Note.create', 'Note.update', 'Note.delete'];

/** The body's value on the detail page (the definition after its label). */
const detail = () => screen.getByText('Text').nextElementSibling as HTMLElement;

describe('the note body with notes.richText off', () => {
  it('shows the text as typed, Markdown characters and all', async () => {
    useNotesApi({
      can: ALL,
      notes: [sampleNote({ body: 'one **two**\nthree' })],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const text = await screen.findByText(/one \*\*two\*\*/);
    expect(text.tagName).toBe('P');
    expect(text).toHaveTextContent('one **two** three');
    expect(detail().querySelector('strong')).toBeNull();
  });

  it('edits in a plain textarea, with no toolbar', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const body = await screen.findByLabelText('Text');
    expect(body.tagName).toBe('TEXTAREA');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});

describe('the note body with notes.richText on', () => {
  it('renders the Markdown: emphasis, lists, safe links, line breaks', async () => {
    useNotesApi({
      can: ALL,
      richText: true,
      notes: [
        sampleNote({
          body: [
            'Plan with **bold** and *slanted* words',
            'second line',
            '',
            '- first',
            '- second',
            '',
            '[docs](https://example.com/docs) and <https://example.org>',
          ].join('\n'),
        }),
      ],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(await screen.findByText('bold')).toBeVisible();
    const view = detail();
    expect(view.querySelector('strong')).toHaveTextContent('bold');
    expect(view.querySelector('em')).toHaveTextContent('slanted');
    expect(within(view).getAllByRole('listitem')).toHaveLength(2);
    // A single newline stays a line break.
    expect(view.querySelector('br')).not.toBeNull();
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(
      screen.getByRole('link', { name: 'https://example.org' }),
    ).toBeVisible();
  });

  it('renders a plain-text body as it read before', async () => {
    useNotesApi({
      can: ALL,
      richText: true,
      notes: [sampleNote({ body: 'Renewals first.\nThen the rest.' })],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const text = await screen.findByText(/Renewals first\./);
    expect(text).toHaveTextContent('Renewals first. Then the rest.');
    expect(text.querySelector('br')).not.toBeNull();
  });

  it('renders an XSS payload inert: no script, no image, no unsafe link', async () => {
    useNotesApi({
      can: ALL,
      richText: true,
      notes: [
        sampleNote({
          body: [
            '<script>window.__pwned = 1</script>',
            '',
            '<img src="x" onerror="window.__pwned = 2">',
            '',
            '[click](javascript:window.__pwned=3)',
            '[tab](java\tscript:window.__pwned=4)',
            '[data](data:text/html;base64,PHNjcmlwdD4=)',
            '[rel](/notes/other)',
            '![remote](https://evil.example/track.png)',
            '<a href="javascript:window.__pwned=5" onclick="window.__pwned=6">raw</a>',
          ].join('\n'),
        }),
      ],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    await screen.findByText(/window\.__pwned = 1/);
    const view = detail();
    expect(view.querySelector('script')).toBeNull();
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('[onerror], [onclick]')).toBeNull();
    // The raw HTML is shown as text, not run.
    expect(view).toHaveTextContent('<img src="x" onerror=');
    for (const anchor of view.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(
        /^(javascript|data|vbscript):/i,
      );
    }
    // The links with an unsafe address are text.
    expect(
      screen.queryByRole('link', { name: 'click' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'data' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'rel' })).not.toBeInTheDocument();
    expect(view).toHaveTextContent('click');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('edits in the editor, which starts from the stored Markdown', async () => {
    useNotesApi({
      can: ALL,
      richText: true,
      notes: [sampleNote({ body: 'Plan with **bold** words' })],
    });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const editor = await screen.findByRole('textbox', { name: 'Text' });
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    expect(editor.querySelector('strong')).toHaveTextContent('bold');
    expect(screen.getByRole('button', { name: 'Bold' })).toBeVisible();
  });

  it('saves what changed as Markdown', async () => {
    const api = useNotesApi({
      can: ALL,
      richText: true,
      notes: [sampleNote({ body: 'Renewals first.' })],
    });
    const { router } = await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    const editor = await screen.findByRole('textbox', { name: 'Text' });
    await user.click(editor);
    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.keyboard('Then this');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await findToast('Note saved');
    await waitFor(() => expect(api.calls.patched).toHaveLength(1));
    const sent = (api.calls.patched[0]!.body as { body: string }).body;
    expect(sent).toContain('Renewals first.');
    expect(sent).toMatch(/\*\*Then this\*\*/);
    expect(router.state.location.pathname).toBe(`/notes/${NOTE_ID}`);
  });

  it('sends nothing for a body the editor did not change', async () => {
    const api = useNotesApi({
      can: ALL,
      richText: true,
      notes: [sampleNote({ body: 'Plan * with   odd _spacing' })],
    });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const user = userEvent.setup();
    await screen.findByRole('textbox', { name: 'Text' });
    await user.type(screen.getByLabelText('Title'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.patched).toHaveLength(1));
    expect(api.calls.patched[0]?.body).toEqual({ title: 'Q3 targets!' });
  });

  it('creates a note with a Markdown body', async () => {
    const api = useNotesApi({ can: ALL, richText: true, notes: [] });
    await renderApp('/notes/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Title'), 'Hello');
    const editor = await screen.findByRole('textbox', { name: 'Text' });
    await user.click(editor);
    await user.click(screen.getByRole('button', { name: 'Bulleted list' }));
    await user.keyboard('first{Enter}second');
    await user.click(screen.getByRole('button', { name: 'Create note' }));
    await waitFor(() => expect(api.calls.created).toHaveLength(1));
    expect(api.calls.created[0]?.body).toMatchObject({
      title: 'Hello',
      body: expect.stringMatching(/^- first\n- second$/),
    });
  });

  it('keeps a script in the stored text inert in the editor', async () => {
    useNotesApi({
      can: ALL,
      richText: true,
      notes: [
        sampleNote({
          body: '<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned = 2">',
        }),
      ],
    });
    await renderApp(`/notes/${NOTE_ID}/edit`);
    const editor = await screen.findByRole('textbox', { name: 'Text' });
    expect(editor.querySelector('script')).toBeNull();
    expect(editor.querySelector('img')).toBeNull();
    expect(document.querySelector('script[src], img[onerror]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
