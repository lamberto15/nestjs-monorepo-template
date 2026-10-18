import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { resourcesFrom } from '@/i18n';
import { createQueryClient } from '@/lib/errors';
import { meQuery } from '@/lib/session';
import { NOTE_ID, sampleNote, useNotesApi } from '@/test/notes-api';
import { MAYA, sampleRevisions, usePanelsApi } from '@/test/panels-api';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { signedInUser } from '@/test/server';
import { splitMentions } from './comment-text';
import { RecordPanels } from './record-panels';

const ALL = [
  'Note.read',
  'Note.create',
  'Note.update',
  'Note.delete',
  'Note.restore',
];
const ME = `user:${signedInUser.user.id}`;
const open = async (tab: string) => {
  // No pause between keystrokes: each one re-renders the whole page.
  const user = userEvent.setup({ delay: null });
  await screen.findByRole('heading', { name: 'Q3 targets' });
  await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
};

describe('comments', () => {
  it('shows the thread with mentions marked, as plain text', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    usePanelsApi({
      users: [MAYA],
      comments: [
        {
          author: `user:${MAYA.id}`,
          body: 'Hi @maya@example.com <b>bold</b> and @user:' + MAYA.id,
        },
        { author: ME, body: 'Mine' },
      ],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    await open('Comments');
    const thread = await screen.findByRole('list', { name: 'Comments' });
    const mentions = thread.querySelectorAll('[data-mention]');
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toHaveTextContent('@maya@example.com');
    expect(mentions[1]).toHaveTextContent('@Maya Patel');
    // No HTML injection: the tag is text.
    expect(thread.querySelector('b')).toBeNull();
    expect(thread).toHaveTextContent('<b>bold</b>');
    expect(within(thread).getByText('You')).toBeVisible();
  });

  it('writes a mention into the body and sends exactly that text', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({ users: [MAYA] });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('Comments');
    const box = await screen.findByLabelText('Write a comment');
    // One keystroke after the "@": with the list open, each key makes the
    // mention measure the caret, which jsdom does slowly (~0.3 s a key), so
    // the list is not narrowed by typing: the person is picked from it.
    await user.type(box, 'Please check, @');
    await user.click(await screen.findByText('Maya Patel'));
    await user.type(box, 'thanks');
    await user.click(screen.getByText('Comment', { selector: 'button' }));
    await waitFor(() => expect(calls.commented).toHaveLength(1));
    expect(calls.commented[0]).toEqual({
      id: NOTE_ID,
      body: { body: 'Please check, @maya@example.com thanks' },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-comment]')).toHaveTextContent(
        'Please check, @maya@example.com thanks',
      ),
    );
  });

  it('edits and deletes only what the user may', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    const calls = usePanelsApi({
      comments: [
        { id: 'theirs', author: `user:${MAYA.id}`, body: 'Theirs' },
        { id: 'mine', author: ME, body: 'Mine' },
      ],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('Comments');
    const items = await screen.findAllByRole('listitem');
    const theirs = items.find((i) => i.dataset.comment === 'theirs')!;
    const mine = items.find((i) => i.dataset.comment === 'mine')!;
    expect(within(theirs).queryByRole('button')).toBeNull();
    await user.click(within(mine).getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit the comment');
    await user.clear(box);
    await user.type(box, 'Better');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.edited).toEqual([
        { commentId: 'mine', body: { body: 'Better' } },
      ]),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(calls.removedComments).toEqual(['mine']));
  });

  it('has no mention list when the directory is forbidden', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    usePanelsApi({ users: 'forbidden' });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('Comments');
    await user.type(await screen.findByLabelText('Write a comment'), '@x');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('splits mentions without touching the rest', () => {
    expect(splitMentions('a @b@c.de, f')).toEqual([
      { text: 'a ' },
      { text: '@b@c.de', mention: '@b@c.de' },
      { text: ', f' },
    ]);
  });
});

describe('attachments', () => {
  it('uploads a file as multipart and lists it', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi();
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('Attachments');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(['hello'], 'plan.txt', { type: 'text/plain' }),
    );
    await waitFor(() =>
      expect(calls.uploaded).toEqual([
        { name: 'plan.txt', type: 'text/plain', size: 5 },
      ]),
    );
    const list = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(list).getByText('plan.txt')).toBeVisible();
    expect(
      within(list).getByRole('link', { name: 'Download plan.txt' }),
    ).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/v1\/attachments\/.+\/download$/),
    );
  });

  it("shows the API's refusal of a type", async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    usePanelsApi({ uploadStatus: 415 });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('Attachments');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, new File(['x'], 'a.exe', { type: 'text/plain' }));
    // The problem is shown twice: as the upload row's error and as a toast.
    // Waiting for both (not for "the" element) leaves nothing to race.
    await waitFor(() =>
      expect(screen.getAllByText('unsupported_media_type (test)')).toHaveLength(
        2,
      ),
    );
  });

  it('lists size and type, and deletes after a confirmation', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({
      attachments: [
        {
          id: 'a1',
          name: 'contract.pdf',
          size: 1536,
          contentType: 'application/pdf',
          uploadedBy: ME,
        },
        {
          id: 'a2',
          name: 'issued.pdf',
          size: 10,
          contentType: 'application/pdf',
          uploadedBy: 'client:1',
          locked: true,
        },
      ],
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('Attachments');
    const row = (await screen.findByText('contract.pdf')).closest('li')!;
    expect(row).toHaveTextContent('PDF');
    expect(row).toHaveTextContent('1.5');
    // An issued document is never deletable.
    expect(
      within(screen.getByText('issued.pdf').closest('li')!).queryByRole(
        'button',
        { name: 'Delete' },
      ),
    ).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(calls.removedAttachments).toEqual([]);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(calls.removedAttachments).toEqual(['a1']));
  });

  it('offers no upload to a reader', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    usePanelsApi();
    await renderApp(`/notes/${NOTE_ID}`);
    await open('Attachments');
    await screen.findByText('No files attached.');
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('tags', () => {
  const tags = [
    { id: 't1', name: 'Internal', color: '#6b7280' },
    { id: 't2', name: 'Urgent', color: '#ef4444' },
  ];

  it('replaces the record’s tags with the chosen ones', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({ tags });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.click(
      await screen.findByRole('button', { name: 'Add tag Urgent' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.tagged).toEqual([{ id: NOTE_ID, tagIds: ['t1', 't2'] }]),
    );
    expect(calls.tagsCreated).toEqual([]);
  });

  it('creates a new tag first when the user may manage tags', async () => {
    useNotesApi({ can: [...ALL, 'Access.manageTags'], notes: [sampleNote()] });
    const calls = usePanelsApi({ tags });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.type(
      await screen.findByLabelText('Tags of this record'),
      'Fresh{Enter}',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.tagged).toHaveLength(1));
    expect(calls.tagsCreated).toEqual([{ subject: 'Note', name: 'Fresh' }]);
    expect(calls.tagged[0]!.tagIds).toEqual(['t1', 'new-Fresh']);
  });

  it('refuses an unknown name without the right to create tags', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({ tags });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.type(
      await screen.findByLabelText('Tags of this record'),
      'Fresh{Enter}',
    );
    await findToast(/There is no tag “Fresh”/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.tagged).toHaveLength(1));
    expect(calls.tagged[0]!.tagIds).toEqual(['t1']);
  });

  it('cannot edit without the right to change the record', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    usePanelsApi({ tags });
    await renderApp(`/notes/${NOTE_ID}`);
    expect(await screen.findByText('Internal')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit tags' })).toBeNull();
  });
});

describe('revisions', () => {
  it('compares two revisions side by side', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({ users: [MAYA], revisions: sampleRevisions });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('History');
    await screen.findByText('Revision 3');
    expect(screen.getByText('By Maya Patel')).toBeVisible();
    await user.click(
      screen.getByRole('checkbox', { name: 'Select revision 3 to compare' }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'Select revision 1 to compare' }),
    );
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    // Always from the older to the newer, whatever the order of the clicks.
    await waitFor(() => expect(calls.diffs).toEqual(['1-3']));
    const diff = await screen.findByRole('region', {
      name: 'Changes from revision 1 to 3',
    });
    const row = diff.querySelector('[data-field="title"]')!;
    expect(row).toHaveTextContent('title');
    expect(row).toHaveTextContent('Draft');
    expect(row).toHaveTextContent('Q3 targets');
  });

  it('restores a revision after a confirmation, with the ETag', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({ revisions: sampleRevisions });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('History');
    await screen.findByText('Revision 1');
    // The current revision has no restore.
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Restore' })[1]!);
    expect(calls.restored).toEqual([]);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restore',
      }),
    );
    await waitFor(() => expect(calls.restored).toHaveLength(1));
    expect(calls.restored[0]).toEqual({
      number: '1',
      ifMatch: expect.stringContaining(NOTE_ID),
    });
    await findToast('Revision restored');
  });

  it('shows the conflict alert on a 412 and reloads on request', async () => {
    useNotesApi({ can: ALL, notes: [sampleNote()] });
    const calls = usePanelsApi({
      revisions: sampleRevisions,
      restoreEtag: '"never"',
    });
    await renderApp(`/notes/${NOTE_ID}`);
    const user = await open('History');
    await screen.findByText('Revision 1');
    await user.click(screen.getAllByRole('button', { name: 'Restore' })[1]!);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restore',
      }),
    );
    expect(
      await screen.findByText('The record changed meanwhile'),
    ).toBeVisible();
    expect(calls.restored).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(screen.queryByText('The record changed meanwhile')).toBeNull(),
    );
  });

  it('offers no restore to a reader', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    usePanelsApi({ revisions: sampleRevisions });
    await renderApp(`/notes/${NOTE_ID}`);
    await open('History');
    await screen.findByText('Revision 1');
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });
});

describe('the panels on a record', () => {
  async function mount(
    can: string[],
    capabilities: Parameters<typeof RecordPanels>[0]['capabilities'],
  ) {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: resourcesFrom(
        import.meta.glob<Record<string, unknown>>('@/locales/en/*.json', {
          eager: true,
          import: 'default',
        }),
      ),
      defaultNS: 'common',
    });
    const queryClient = createQueryClient(() => undefined);
    queryClient.setQueryData(meQuery.queryKey, {
      ...signedInUser,
      can: Object.fromEntries(can.map((p) => [p, true])),
    } as never);
    return render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RecordPanels
            subject="Note"
            path="/v1/notes/{id}"
            id={NOTE_ID}
            capabilities={capabilities}
            tags={[]}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    );
  }

  it('shows only the panels the feature supports', async () => {
    useNotesApi({ can: ALL, notes: [] });
    usePanelsApi();
    await mount(ALL, { comments: true, revisions: true });
    expect(await screen.findByRole('tab', { name: 'Comments' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'History' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Attachments' })).toBeNull();
    expect(screen.queryByText('Tags')).toBeNull();
  });

  it('shows nothing when the feature supports none', async () => {
    useNotesApi({ can: ALL, notes: [] });
    usePanelsApi();
    const { container } = await mount(ALL, {});
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing to a user who may not read the record', async () => {
    useNotesApi({ can: ALL, notes: [] });
    usePanelsApi();
    const { container } = await mount([], {
      comments: true,
      attachments: true,
      tags: true,
      revisions: true,
    });
    expect(container).toBeEmptyDOMElement();
  });
});
