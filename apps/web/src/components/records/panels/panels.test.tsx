import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { recordKeys } from '@/lib/records';
import {
  MAYA,
  TEST_RECORD,
  sampleRevisions,
  usePanelsApi,
} from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { findToast } from '@/test/toast';
import { signedInUser } from '@/test/server';
import { splitMentions } from './comment-text';
import { RecordPanels, type RecordCapabilities } from './record-panels';

// The panels on a test-only subject's record (TEST_RECORD), mounted alone:
// no feature's page hosts them, so they stand without any feature.
const ID = '0199a3f2-0000-7000-8000-000000000601';
const ALL = [
  'TestItem.read',
  'TestItem.create',
  'TestItem.update',
  'TestItem.delete',
  'TestItem.restore',
];
const ME = `user:${signedInUser.user.id}`;
const EVERY_PANEL: RecordCapabilities = {
  comments: true,
  attachments: true,
  tags: true,
  revisions: true,
};
/** The record's ETag, as its page would have cached it with the record. */
const ETAG = `"${ID}-1"`;

async function mountPanels(
  can: string[],
  capabilities: RecordCapabilities = EVERY_PANEL,
) {
  const view = await renderComponent(
    <RecordPanels
      subject={TEST_RECORD.subject}
      path={TEST_RECORD.path}
      id={ID}
      capabilities={capabilities}
      tags={[{ id: 't1', name: 'Internal', color: '#6b7280' }]}
    />,
    { can },
  );
  view.queryClient.setQueryData(
    recordKeys.detail(TEST_RECORD.path.replace('/{id}', ''), ID),
    { etag: ETAG },
  );
  return view;
}

const open = async (tab: string) => {
  // No pause between keystrokes: each one re-renders the panels.
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
};

describe('comments', () => {
  it('shows the thread with mentions marked, as plain text', async () => {
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
    await mountPanels(ALL);
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
    const calls = usePanelsApi({ users: [MAYA] });
    await mountPanels(ALL);
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
      id: ID,
      body: { body: 'Please check, @maya@example.com thanks' },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-comment]')).toHaveTextContent(
        'Please check, @maya@example.com thanks',
      ),
    );
  });

  it('edits and deletes only what the user may', async () => {
    const calls = usePanelsApi({
      comments: [
        { id: 'theirs', author: `user:${MAYA.id}`, body: 'Theirs' },
        { id: 'mine', author: ME, body: 'Mine' },
      ],
    });
    await mountPanels(['TestItem.read']);
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
    usePanelsApi({ users: 'forbidden' });
    await mountPanels(ALL);
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
    const calls = usePanelsApi();
    await mountPanels(ALL);
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
    usePanelsApi({ uploadStatus: 415 });
    await mountPanels(ALL);
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
    await mountPanels(ALL);
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
    usePanelsApi();
    await mountPanels(['TestItem.read']);
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
    const calls = usePanelsApi({ tags });
    await mountPanels(ALL);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.click(
      await screen.findByRole('button', { name: 'Add tag Urgent' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.tagged).toEqual([{ id: ID, tagIds: ['t1', 't2'] }]),
    );
    expect(calls.tagsCreated).toEqual([]);
  });

  it('creates a new tag first when the user may manage tags', async () => {
    const calls = usePanelsApi({ tags });
    await mountPanels([...ALL, 'Access.manageTags']);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.type(
      await screen.findByLabelText('Tags of this record'),
      'Fresh{Enter}',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.tagged).toHaveLength(1));
    expect(calls.tagsCreated).toEqual([{ subject: 'TestItem', name: 'Fresh' }]);
    expect(calls.tagged[0]!.tagIds).toEqual(['t1', 'new-Fresh']);
  });

  it('refuses an unknown name without the right to create tags', async () => {
    const calls = usePanelsApi({ tags });
    await mountPanels(ALL);
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
    usePanelsApi({ tags });
    await mountPanels(['TestItem.read']);
    expect(await screen.findByText('Internal')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit tags' })).toBeNull();
  });
});

describe('revisions', () => {
  it('compares two revisions side by side', async () => {
    const calls = usePanelsApi({ users: [MAYA], revisions: sampleRevisions });
    await mountPanels(ALL);
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
    const calls = usePanelsApi({ revisions: sampleRevisions });
    await mountPanels(ALL);
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
      ifMatch: ETAG,
    });
    await findToast('Revision restored');
  });

  it('shows the conflict alert on a 412 and reloads on request', async () => {
    const calls = usePanelsApi({
      revisions: sampleRevisions,
      restoreEtag: '"never"',
    });
    await mountPanels(ALL);
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
    usePanelsApi({ revisions: sampleRevisions });
    await mountPanels(['TestItem.read']);
    await open('History');
    await screen.findByText('Revision 1');
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });
});

describe('the panels on a record', () => {
  it('shows only the panels the feature supports', async () => {
    usePanelsApi();
    await mountPanels(ALL, { comments: true, revisions: true });
    expect(await screen.findByRole('tab', { name: 'Comments' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'History' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Attachments' })).toBeNull();
    expect(screen.queryByText('Tags')).toBeNull();
  });

  // The router's outlet and the toaster are all there is then.
  const nothingShown = () => {
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Tags')).toBeNull();
  };

  it('shows nothing when the feature supports none', async () => {
    usePanelsApi();
    await mountPanels(ALL, {});
    nothingShown();
  });

  it('shows nothing to a user who may not read the record', async () => {
    usePanelsApi();
    await mountPanels([]);
    nothingShown();
  });
});
