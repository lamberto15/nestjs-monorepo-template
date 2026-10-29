import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeProvider } from '@/lib/realtime';
import { recordKeys } from '@/lib/records';
import { meQuery, type Features } from '@/lib/session';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import {
  MAYA,
  TEST_RECORD,
  sampleRevisions,
  panelsDescription,
  usePanelsApi,
} from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { findToast } from '@/test/toast';
import { problem, server, signedInUser } from '@/test/server';
import { CommentEditor } from './comments-panel';
import { splitMentions } from './comment-text';
import { RecordPanels } from './record-panels';

const connections: FakeRealtime[] = [];
vi.mock('@nestjs-monorepo-template/api-client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@nestjs-monorepo-template/api-client')
  >()),
  createRealtime: vi.fn(() => {
    const fake = createFakeRealtime();
    connections.push(fake);
    return fake;
  }),
}));

beforeEach(() => {
  connections.length = 0;
});

// The panels on a test-only subject's record (TEST_RECORD), mounted alone
// (with the session's socket, a fake): no feature's page hosts them, so they
// stand without any feature. What the subject takes is the API's answer
// (usePanelsApi's `capabilities`, all four by default).
const ID = '0199a3f2-0000-7000-8000-000000000601';
const ALL = [
  'TestItem.read',
  'TestItem.create',
  'TestItem.update',
  'TestItem.delete',
  'TestItem.restore',
];
const ME = `user:${signedInUser.user.id}`;
/** The record's ETag, as its page would have cached it with the record. */
const ETAG = `"${ID}-1"`;

async function mountPanels(can: string[], features?: Partial<Features>) {
  const view = await renderComponent(
    <RealtimeProvider>
      <RecordPanels
        subject={TEST_RECORD.subject}
        path={TEST_RECORD.path}
        id={ID}
        tags={[{ id: 't1', name: 'Internal', color: '#6b7280' }]}
      />
    </RealtimeProvider>,
    { can, features },
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
      comments: [
        {
          author: `user:${MAYA.id}`,
          body: 'Hi @maya@example.com <b>bold</b> and @user:' + MAYA.id,
          mentionNames: { [`user:${MAYA.id}`]: MAYA.name },
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

  it('names the mentions the API named', async () => {
    const OTTO = '0199a3f2-0000-7000-8000-000000000004';
    usePanelsApi({
      comments: [
        {
          body: `cc @user:${OTTO}`,
          mentions: [`user:${OTTO}`],
          mentionNames: { [`user:${OTTO}`]: 'Otto Lang' },
        },
      ],
    });
    await mountPanels(ALL);
    await open('Comments');
    const thread = await screen.findByRole('list', { name: 'Comments' });
    expect(thread.querySelector('[data-mention]')).toHaveTextContent(
      '@Otto Lang',
    );
  });

  it("names authors as the API does, and someone it doesn't", async () => {
    const stranger = '0199a3f2-0000-7000-8000-000000000003';
    usePanelsApi({
      comments: [
        { author: `user:${MAYA.id}`, authorName: 'Maya P.', body: 'Hello' },
        {
          author: `user:${stranger}`,
          authorName: null,
          body: `cc @user:${stranger}`,
          mentionNames: { [`user:${stranger}`]: null },
        },
        { author: 'client:1', authorName: null, body: 'Imported' },
      ],
    });
    await mountPanels(ALL);
    await open('Comments');
    const thread = await screen.findByRole('list', { name: 'Comments' });
    expect(within(thread).getByText('Maya P.')).toBeVisible();
    expect(within(thread).getByText('System')).toBeVisible();
    expect(within(thread).getByText('Someone')).toBeVisible();
    // A mention the API cannot name (null) stays as written.
    expect(thread.querySelector('[data-mention]')).toHaveTextContent(
      `@user:${stranger}`,
    );
  });

  // The comment box, once the people it offers are asked for (the first
  // ones by name, without `q`: an empty one is a 400).
  const startComment = async (calls: ReturnType<typeof usePanelsApi>) => {
    await mountPanels(ALL);
    const user = await open('Comments');
    const box = await screen.findByLabelText('Write a comment');
    await waitFor(() => expect(calls.peopleQueries).toContain(''));
    return { user, box };
  };
  const send = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByText('Comment', { selector: 'button' }));
  /** Waits for the sent comment's box: a new one, the old one is gone. */
  const newBox = () =>
    waitFor(() => {
      const box = screen.getByLabelText('Write a comment');
      expect(box).toHaveValue('');
      return box;
    });

  it('writes a mention into the body and sends exactly that text', async () => {
    const calls = usePanelsApi({ people: [MAYA] });
    const { user, box } = await startComment(calls);
    // One keystroke after the "@": with the list open, each key makes the
    // mention measure the caret, which jsdom does slowly (~0.3 s a key), so
    // the list is not narrowed by typing: the person is picked from it.
    await user.type(box, 'Please check, @');
    await user.click(await screen.findByText('Maya Patel'));
    // The box shows the name, never the key the API reads.
    expect(box).toHaveValue('Please check, @Maya Patel ');
    await user.type(box, 'thanks');
    await send(user);
    await waitFor(() => expect(calls.commented).toHaveLength(1));
    // `@user:<id>`, what the API reads (docs/comments.md).
    expect(calls.commented[0]).toEqual({
      id: ID,
      body: { body: `Please check, @user:${MAYA.id} thanks` },
    });
    // Shown with the person's name.
    await waitFor(() =>
      expect(document.querySelector('[data-comment]')).toHaveTextContent(
        'Please check, @Maya Patel thanks',
      ),
    );
  });

  it('holds a comment draft after a verified session change until the user submits again', async () => {
    usePanelsApi({ people: [] });
    const queryClient = new QueryClient();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const submit = vi.fn().mockResolvedValue(undefined);
    await renderComponent(
      <CommentEditor
        label="Write a comment"
        placeholder="Write a comment"
        submit="Comment"
        busy={false}
        onSubmit={submit}
      />,
      { can: ALL, queryClient },
    );
    const user = userEvent.setup({ delay: null });
    const box = await screen.findByLabelText('Write a comment');
    await user.type(box, 'Keep this comment');

    const nextTenant = '0199a3f2-0000-7000-8000-00000000002a';
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          tenant: {
            ...signedInUser.tenant!,
            id: nextTenant,
            slug: 'globex',
            name: 'Globex',
          },
        }),
      ),
    );
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });

    await send(user);
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining('Nothing was sent'),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Write a comment')).toHaveValue(
      'Keep this comment',
    );

    await send(user);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith('Keep this comment');
    alert.mockRestore();
  });

  it('sends each id when two people have one name', async () => {
    const ALEX = { email: 'alex@example.com', name: 'Alex Kim' };
    const FIRST = { ...ALEX, id: '0199a3f2-0000-7000-8000-0000000000a1' };
    const SECOND = { ...ALEX, id: '0199a3f2-0000-7000-8000-0000000000a2' };
    const calls = usePanelsApi({ people: [FIRST, SECOND] });
    const { user, box } = await startComment(calls);
    await user.type(box, '@');
    await user.click((await screen.findAllByRole('option'))[1]!);
    await user.type(box, 'and @');
    await user.click((await screen.findAllByRole('option'))[0]!);
    // Told apart in the box, one id each in the body.
    const [one, two] = (box as HTMLInputElement).value.split(' and ');
    expect(one).not.toBe(two!.trim());
    await send(user);
    await waitFor(() => expect(calls.commented).toHaveLength(1));
    expect(calls.commented[0]).toEqual({
      id: ID,
      body: { body: `@user:${SECOND.id} and @user:${FIRST.id}` },
    });
  });

  it('clears the box after sending, and offers the mention list again', async () => {
    const calls = usePanelsApi({ people: [MAYA] });
    const { user, box } = await startComment(calls);
    await user.type(box, '@');
    await user.click(await screen.findByText('Maya Patel'));
    await send(user);
    await waitFor(() => expect(calls.commented).toHaveLength(1));
    // A new box: the old one's mentions are forgotten with it.
    const next = await newBox();
    // The old mention's place is forgotten: no text of the new comment is
    // marked as a mention, and a new `@` opens the list again.
    await user.type(next, 'Hello there');
    expect(document.querySelector('[data-tag]')).toBeNull();
    await user.type(next, ' @');
    expect(await screen.findByRole('option')).toBeVisible();
  });

  it('does not turn a name typed by hand into a mention after a send', async () => {
    const calls = usePanelsApi({ people: [MAYA] });
    const { user, box } = await startComment(calls);
    await user.type(box, '@');
    await user.click(await screen.findByText('Maya Patel'));
    await send(user);
    await waitFor(() => expect(calls.commented).toHaveLength(1));
    // The new box has picked nobody: the same words are only text.
    fireEvent.change(await newBox(), { target: { value: '@Maya Patel' } });
    await send(user);
    await waitFor(() => expect(calls.commented).toHaveLength(2));
    expect(calls.commented[1]).toEqual({
      id: ID,
      body: { body: '@Maya Patel' },
    });
  });

  describe('when sending fails', () => {
    // The first attempt is refused (409), the second goes through.
    const refuseOnce = () =>
      server.use(
        http.post(
          '/v1/test-items/:id/comments',
          () => problem(409, 'conflict'),
          { once: true },
        ),
      );

    it('keeps the text', async () => {
      const calls = usePanelsApi({ people: [MAYA] });
      const { user, box } = await startComment(calls);
      refuseOnce();
      await user.type(box, 'Do not lose me');
      await send(user);
      await findToast('conflict (test)');
      expect(box).toHaveValue('Do not lose me');
    });

    it('keeps the people picked, and sends them on the next try', async () => {
      const calls = usePanelsApi({ people: [MAYA] });
      const { user, box } = await startComment(calls);
      refuseOnce();
      await user.type(box, 'Please check, @');
      await user.click(await screen.findByText('Maya Patel'));
      await user.type(box, 'thanks');
      await send(user);
      await findToast('conflict (test)');
      expect(box).toHaveValue('Please check, @Maya Patel thanks');
      await send(user);
      await waitFor(() => expect(calls.commented).toHaveLength(1));
      expect(calls.commented[0]).toEqual({
        id: ID,
        body: { body: `Please check, @user:${MAYA.id} thanks` },
      });
    });
  });

  it("asks the directory for the names of a comment's first 20 mentions only", async () => {
    const ids = Array.from(
      { length: 25 },
      (_, i) => `0199a3f2-0000-7000-8000-${String(1000 + i).padStart(12, '0')}`,
    );
    usePanelsApi({
      comments: [{ body: ids.map((id) => `@user:${id}`).join(' ') }],
    });
    const asked: string[] = [];
    server.use(
      http.get('/v1/people', ({ request }) => {
        const keys = new URL(request.url).searchParams.get('key');
        asked.push(...(keys?.split(',') ?? []));
        return HttpResponse.json({ items: [] });
      }),
    );
    await mountPanels(ALL);
    await open('Comments');
    await screen.findByRole('list', { name: 'Comments' });
    const mentioned = () =>
      asked.filter((key) => ids.some((id) => key === `user:${id}`));
    await waitFor(() => expect(mentioned()).toHaveLength(20));
    expect(mentioned()).not.toContain(`user:${ids[20]}`);
  });

  // The user's own comment mentioning Maya is edited: the box shows her name,
  // and the id goes back where it was (the API reads a mention next to a
  // bracket too, so the edit must not lose it).
  it.each([
    ['Ask @user:{id} first', 'Ask @Maya Patel first'],
    ['Ask (@user:{id}) first', 'Ask (@Maya Patel) first'],
  ])('edits %s from its text, mentions by name', async (stored, shown) => {
    const body = stored.replace('{id}', MAYA.id);
    const calls = usePanelsApi({
      comments: [
        {
          id: 'mine',
          author: ME,
          body,
          mentions: [`user:${MAYA.id}`],
          mentionNames: { [`user:${MAYA.id}`]: MAYA.name },
        },
      ],
    });
    await mountPanels(['TestItem.read']);
    const user = await open('Comments');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit the comment');
    expect(box).toHaveValue(shown);
    await user.type(box, ' today');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.edited).toEqual([
        { commentId: 'mine', body: { body: `${body} today` } },
      ]),
    );
  });

  it('names a mention the API did not resolve, by the people directory', async () => {
    // A mention of oneself, or of someone who may not read the record, is
    // dropped from `mentions` and so has no `mentionNames` entry.
    usePanelsApi({
      comments: [
        { author: ME, body: `Note to @user:${MAYA.id}`, mentions: [] },
      ],
    });
    await mountPanels(ALL);
    await open('Comments');
    const thread = await screen.findByRole('list', { name: 'Comments' });
    await waitFor(() =>
      expect(thread.querySelector('[data-mention]')).toHaveTextContent(
        '@Maya Patel',
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

  it('says why a comment was not deleted, and shows what is true', async () => {
    const calls = usePanelsApi({
      comments: [{ id: 'mine', author: ME, body: 'Mine' }],
    });
    server.use(
      http.delete('/v1/test-items/:id/comments/:commentId', () =>
        problem(409, 'conflict'),
      ),
    );
    await mountPanels(['TestItem.read']);
    const user = await open('Comments');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const listings = calls.commentListings;
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );
    await findToast('conflict (test)');
    // Whoever refused may have been right: the thread is read again.
    await waitFor(() =>
      expect(calls.commentListings).toBeGreaterThan(listings),
    );
  });

  it('searches the people by what follows the @', async () => {
    const calls = usePanelsApi({ people: [MAYA] });
    await mountPanels(ALL);
    const user = await open('Comments');
    await user.type(await screen.findByLabelText('Write a comment'), '@ma');
    await waitFor(() => expect(calls.peopleQueries).toContain('ma'));
  });

  it('has no mention list when nobody matches', async () => {
    usePanelsApi({ people: [] });
    await mountPanels(ALL);
    const user = await open('Comments');
    await user.type(await screen.findByLabelText('Write a comment'), '@x');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('names mentions from mentionNames, case-insensitively, else keeps the raw text', () => {
    const id = MAYA.id.toUpperCase();
    expect(
      splitMentions(`hi @user:${id} and @user:${ID} @a@b.co`, {
        [`user:${MAYA.id}`]: MAYA.name,
      }),
    ).toEqual([
      { text: 'hi ' },
      { text: '@Maya Patel', mention: `@user:${id}` },
      { text: ' and ' },
      { text: `@user:${ID}`, mention: `@user:${ID}` },
      { text: ' ' },
      { text: '@a@b.co', mention: '@a@b.co' },
    ]);
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

  it('takes a file dropped anywhere on the page, saying so while it is dragged', async () => {
    const calls = usePanelsApi();
    await mountPanels(ALL);
    const user = await open('Attachments');
    // A real FileList (jsdom has no DataTransfer to build one).
    const picker = document.createElement('input');
    picker.type = 'file';
    await user.upload(
      picker,
      new File(['hello'], 'plan.txt', { type: 'text/plain' }),
    );
    const dataTransfer = { types: ['Files'], files: picker.files };
    fireEvent.dragOver(document.body, { dataTransfer });
    expect(
      await screen.findByText('Drop to attach to this record'),
    ).toBeVisible();
    // jsdom's input takes only its own FileList; a browser takes the drop's.
    Object.defineProperty(
      document.querySelector('input[type="file"]')!,
      'files',
      { value: null, writable: true, configurable: true },
    );
    fireEvent.drop(document.body, { dataTransfer });
    await waitFor(() =>
      expect(calls.uploaded).toEqual([
        { name: 'plan.txt', type: 'text/plain', size: 5 },
      ]),
    );
    expect(screen.queryByText('Drop to attach to this record')).toBeNull();
  });

  describe('direct uploads (the API offers presignedUploads: STORAGE_DRIVER=s3)', () => {
    const direct = { presignedUploads: true };
    const plan = () => new File(['hello'], 'plan.txt', { type: 'text/plain' });
    const upload = async (file: File) => {
      const user = await open('Attachments');
      await user.upload(
        document.querySelector('input[type="file"]') as HTMLInputElement,
        file,
      );
    };

    it('sends the file to the store with the signed headers, then completes it, and never through the API', async () => {
      const calls = usePanelsApi();
      await mountPanels(ALL, direct);
      await upload(plan());
      const list = await screen.findByRole('list', { name: 'Attachments' });
      expect(within(list).getByText('plan.txt')).toBeVisible();
      expect(calls.presigned).toEqual([
        { name: 'plan.txt', size: 5, contentType: 'text/plain' },
      ]);
      expect(calls.stored).toEqual([
        {
          url: expect.stringMatching(
            /^https:\/\/files\.example\.test\/tenants\/t\/attachments\/u1\?/,
          ),
          type: 'text/plain',
          size: 5,
        },
      ]);
      expect(calls.completed).toEqual(['u1']);
      // The multipart route was not used.
      expect(calls.uploaded).toEqual([]);
    });

    it('uploads through the API instead when the browser cannot reach the store (a bucket with no CORS rule)', async () => {
      const calls = usePanelsApi({ direct: { store: 'unreachable' } });
      await mountPanels(ALL, direct);
      await upload(plan());
      await waitFor(() =>
        expect(calls.uploaded).toEqual([
          { name: 'plan.txt', type: 'text/plain', size: 5 },
        ]),
      );
      expect(calls.completed).toEqual([]);
      const list = await screen.findByRole('list', { name: 'Attachments' });
      expect(within(list).getByText('plan.txt')).toBeVisible();
    });

    it('uploads through the API instead when the server turns out to offer none (503)', async () => {
      const calls = usePanelsApi({
        direct: {
          presign: { status: 503, code: 'presigned_uploads_unavailable' },
        },
      });
      await mountPanels(ALL, direct);
      await upload(plan());
      await waitFor(() => expect(calls.uploaded).toHaveLength(1));
      expect(calls.stored).toEqual([]);
    });

    it('uploads through the API instead when the user has too many announced uploads open (429)', async () => {
      const calls = usePanelsApi({
        direct: {
          presign: { status: 429, code: 'attachment_uploads_pending' },
        },
      });
      await mountPanels(ALL, direct);
      await upload(plan());
      await waitFor(() => expect(calls.uploaded).toHaveLength(1));
      expect(calls.stored).toEqual([]);
      const list = await screen.findByRole('list', { name: 'Attachments' });
      expect(within(list).getByText('plan.txt')).toBeVisible();
    });

    it('uploads through the API a file the browser cannot name the type of', async () => {
      const calls = usePanelsApi();
      await mountPanels(ALL, direct);
      await upload(new File(['hello'], 'README', { type: '' }));
      await waitFor(() => expect(calls.uploaded).toHaveLength(1));
      expect(calls.presigned).toEqual([]);
    });

    it("shows the API's refusal of the announcement and does not retry through the API", async () => {
      const calls = usePanelsApi({
        direct: { presign: { status: 415, code: 'unsupported_media_type' } },
      });
      await mountPanels(ALL, direct);
      await upload(plan());
      await findToast('unsupported_media_type (test)');
      expect(calls.uploaded).toEqual([]);
      expect(calls.stored).toEqual([]);
    });

    it("tells the store's refusal (an expired link) and attaches nothing", async () => {
      const calls = usePanelsApi({ direct: { store: 'refused' } });
      await mountPanels(ALL, direct);
      await upload(plan());
      await findToast(
        'The file could not be stored: the upload link was refused or has expired. Try again.',
      );
      expect(calls.completed).toEqual([]);
      expect(calls.uploaded).toEqual([]);
    });
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

  it('says why a file was not deleted, and shows what is true', async () => {
    const calls = usePanelsApi({
      attachments: [
        {
          id: 'a1',
          name: 'contract.pdf',
          size: 1536,
          contentType: 'application/pdf',
          uploadedBy: ME,
        },
      ],
    });
    server.use(
      http.delete('/v1/attachments/:id', () => problem(403, 'forbidden')),
    );
    await mountPanels(ALL);
    const user = await open('Attachments');
    const row = (await screen.findByText('contract.pdf')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const listings = calls.attachmentListings;
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );
    await findToast('forbidden (test)');
    await waitFor(() =>
      expect(calls.attachmentListings).toBeGreaterThan(listings),
    );
  });

  it("holds uploads to the API's limits", async () => {
    const calls = usePanelsApi({
      attachmentLimits: {
        maxBytes: 4,
        maxMb: 0,
        types: ['text/plain', 'application/pdf'],
      },
    });
    await mountPanels(ALL);
    const user = await open('Attachments');
    expect(
      await screen.findByText('At most 4 byte each. Accepted: TXT, PDF.'),
    ).toBeVisible();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(['hello'], 'big.txt', { type: 'text/plain' }),
    );
    await findToast('big.txt: the file is larger than 4 byte');
    await user.upload(input, new File(['x'], 'a.png', { type: 'image/png' }));
    await findToast('a.png: this type of file is not accepted');
    expect(calls.uploaded).toEqual([]);
  });

  it('offers no upload to a reader', async () => {
    usePanelsApi();
    await mountPanels(['TestItem.read']);
    await open('Attachments');
    await screen.findByText('No files attached.');
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  describe('malware scan', () => {
    const files = [
      {
        id: 'a1',
        name: 'incoming.pdf',
        size: 2048,
        contentType: 'application/pdf',
        uploadedBy: ME,
        scanStatus: 'pending' as const,
      },
      {
        id: 'a2',
        name: 'checked.pdf',
        size: 2048,
        contentType: 'application/pdf',
        uploadedBy: ME,
        scanStatus: 'clean' as const,
      },
    ];

    it('marks a file still being scanned and offers no download for it', async () => {
      usePanelsApi({ attachments: files });
      await mountPanels(ALL);
      await open('Attachments');
      const pending = (await screen.findByText('incoming.pdf')).closest('li')!;
      expect(within(pending).getByRole('status')).toHaveTextContent(
        'Scanning…',
      );
      // No link to follow (the API answers 409 until the scan is done): a
      // disabled button that says why.
      expect(within(pending).queryByRole('link')).toBeNull();
      expect(
        within(pending).getByRole('button', {
          name: 'Download incoming.pdf: available when the scan is done',
        }),
      ).toBeDisabled();
      // It can still be removed, as the API allows.
      expect(
        within(pending).getByRole('button', { name: 'Delete' }),
      ).toBeEnabled();
      // A clean file is as before: a link, no badge.
      const clean = screen.getByText('checked.pdf').closest('li')!;
      expect(within(clean).queryByRole('status')).toBeNull();
      expect(
        within(clean).getByRole('link', { name: 'Download checked.pdf' }),
      ).toHaveAttribute('href', '/v1/attachments/a2/download');
    });

    it('lists a new upload as being scanned', async () => {
      usePanelsApi({ uploadScanStatus: 'pending' });
      await mountPanels(ALL);
      const user = await open('Attachments');
      await user.upload(
        document.querySelector('input[type="file"]') as HTMLInputElement,
        new File(['hello'], 'plan.txt', { type: 'text/plain' }),
      );
      const list = await screen.findByRole('list', { name: 'Attachments' });
      expect(within(list).getByText('plan.txt')).toBeVisible();
      expect(within(list).getByRole('status')).toHaveTextContent('Scanning…');
      expect(within(list).queryByRole('link')).toBeNull();
    });

    it('polls for the scan while there is no connected socket', async () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval'],
        shouldAdvanceTime: true,
      });
      try {
        const calls = usePanelsApi({ attachments: files });
        await mountPanels(ALL);
        await open('Attachments');
        const pending = (await screen.findByText('incoming.pdf')).closest(
          'li',
        )!;
        expect(within(pending).getByRole('status')).toBeVisible();
        const listed = calls.attachmentListings;
        // The worker finishes; the page notices on its next read.
        calls.scanClean('a1');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        await waitFor(() =>
          expect(
            within(screen.getByText('incoming.pdf').closest('li')!).getByRole(
              'link',
              { name: 'Download incoming.pdf' },
            ),
          ).toBeVisible(),
        );
        expect(calls.attachmentListings).toBeGreaterThan(listed);
        expect(screen.queryByText('Scanning…')).toBeNull();
        // Nothing left to scan: no more reads.
        const settled = calls.attachmentListings;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(calls.attachmentListings).toBe(settled);
      } finally {
        vi.useRealTimers();
      }
    });

    it('polls for the scan with a connected socket that never hears of its end', async () => {
      // The scan job acts as the system principal: `scanned` goes to the
      // record's watchers, and an uploader who is not one gets no event.
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval'],
        shouldAdvanceTime: true,
      });
      try {
        const calls = usePanelsApi({ attachments: files });
        await mountPanels(ALL);
        await open('Attachments');
        await screen.findByText('incoming.pdf');
        await waitFor(() => expect(connections).toHaveLength(1));
        act(() => connections[0]!.emit('connect'));
        calls.scanClean('a1');
        const listed = calls.attachmentListings;
        // Not yet: a connected socket is read less often than none.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(calls.attachmentListings).toBe(listed);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(
          await screen.findByRole('link', { name: 'Download incoming.pdf' }),
        ).toBeVisible();
        expect(calls.attachmentListings).toBeGreaterThan(listed);
        expect(screen.queryByText('Scanning…')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
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
    const calls = usePanelsApi({ revisions: sampleRevisions });
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

describe('realtime', () => {
  const socket = async () => {
    await waitFor(() => expect(connections).toHaveLength(1));
    return connections[0]!;
  };

  it("reloads the comments on the record's record.commented, not another's", async () => {
    usePanelsApi({ comments: [{ body: 'First' }] });
    await mountPanels(ALL);
    await open('Comments');
    await screen.findByText('First');
    const fake = await socket();
    // Another record's, then another subject's: nothing to reload.
    // Only the comments' own requests: an author's picture is looked up
    // beside them (GET /v1/people?key=), at a time of its own.
    let requests = 0;
    const count = ({ request }: { request: Request }) => {
      if (new URL(request.url).pathname.endsWith('/comments')) requests += 1;
    };
    server.events.on('request:start', count);
    act(() => {
      fake.emit('record.commented', {
        subject: TEST_RECORD.subject,
        recordId: 'other',
        commentId: 'c9',
        action: 'added',
      });
      fake.emit('record.commented', {
        subject: 'Other',
        recordId: ID,
        commentId: 'c9',
        action: 'added',
      });
    });
    await act(() => Promise.resolve());
    expect(requests).toBe(0);
    act(() =>
      fake.emit('record.commented', {
        subject: TEST_RECORD.subject,
        recordId: ID,
        commentId: 'c9',
        action: 'added',
      }),
    );
    await waitFor(() => expect(requests).toBe(1));
    server.events.removeListener('request:start', count);
  });

  it('reloads the files on record.attachments.changed', async () => {
    usePanelsApi();
    await mountPanels(ALL);
    await open('Attachments');
    await screen.findByText('No files attached.');
    const fake = await socket();
    // Another tab (or a PDF issued) added one.
    server.use(
      http.get(`${TEST_RECORD.path.replace('{id}', ':id')}/attachments`, () =>
        HttpResponse.json({
          items: [
            {
              id: 'a9',
              subject: TEST_RECORD.subject,
              recordId: ID,
              name: 'issued.pdf',
              size: 10,
              contentType: 'application/pdf',
              uploadedBy: 'client:1',
              locked: true,
              createdAt: '2026-10-17T09:40:00.000Z',
              updatedAt: '2026-10-17T09:40:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    act(() =>
      fake.emit('record.attachments.changed', {
        subject: TEST_RECORD.subject,
        recordId: ID,
        attachmentId: 'a9',
        action: 'added',
      }),
    );
    expect(await screen.findByText('issued.pdf')).toBeVisible();
  });

  it('turns a scanned file downloadable on record.attachments.changed (scanned)', async () => {
    const calls = usePanelsApi({
      attachments: [
        {
          id: 'a1',
          name: 'incoming.pdf',
          size: 2048,
          contentType: 'application/pdf',
          uploadedBy: ME,
          scanStatus: 'pending',
        },
      ],
    });
    await mountPanels(ALL);
    await open('Attachments');
    const row = (await screen.findByText('incoming.pdf')).closest('li')!;
    expect(within(row).getByRole('status')).toHaveTextContent('Scanning…');
    const fake = await socket();
    act(() => fake.emit('connect'));
    calls.scanClean('a1');
    act(() =>
      fake.emit('record.attachments.changed', {
        subject: TEST_RECORD.subject,
        recordId: ID,
        attachmentId: 'a1',
        action: 'scanned',
      }),
    );
    expect(
      await screen.findByRole('link', { name: 'Download incoming.pdf' }),
    ).toHaveAttribute('href', '/v1/attachments/a1/download');
    expect(screen.queryByText('Scanning…')).toBeNull();
  });

  it('shows the thumbnail of an image on record.attachments.changed (processed)', async () => {
    const calls = usePanelsApi({
      attachments: [
        {
          id: 'a1',
          name: 'photo.jpg',
          size: 204_800,
          contentType: 'image/jpeg',
          uploadedBy: ME,
          renditionStatus: 'pending',
        },
      ],
    });
    await mountPanels(ALL);
    await open('Attachments');
    const row = (await screen.findByText('photo.jpg')).closest('li')!;
    expect(
      within(row).getByRole('img', { name: 'Preparing preview…' }),
    ).toBeVisible();
    const fake = await socket();
    act(() => fake.emit('connect'));
    // The worker is done; the event is the signal to read the list again.
    calls.processed('a1', {
      thumb: {
        width: 256,
        height: 171,
        size: 9_000,
        contentType: 'image/webp',
      },
      preview: {
        width: 1600,
        height: 1067,
        size: 120_000,
        contentType: 'image/webp',
      },
    });
    act(() =>
      fake.emit('record.attachments.changed', {
        subject: TEST_RECORD.subject,
        recordId: ID,
        attachmentId: 'a1',
        action: 'processed',
      }),
    );
    expect(
      await within(row).findByRole('button', { name: 'Preview photo.jpg' }),
    ).toBeVisible();
    expect(row.querySelector('img')).toHaveAttribute(
      'src',
      '/v1/attachments/a1/download?rendition=thumb',
    );
    expect(
      screen.queryByRole('img', { name: 'Preparing preview…' }),
    ).toBeNull();
  });

  it('drops a file the scan rejected and tells its uploader why', async () => {
    const calls = usePanelsApi({
      attachments: [
        {
          id: 'a1',
          name: 'virus.pdf',
          size: 2048,
          contentType: 'application/pdf',
          uploadedBy: ME,
          scanStatus: 'pending',
        },
      ],
    });
    await mountPanels(ALL);
    await open('Attachments');
    await screen.findByText('virus.pdf');
    const fake = await socket();
    // The API deletes an infected file: its row is gone, then it says so.
    calls.scanInfected('a1');
    act(() =>
      fake.emit('record.attachments.changed', {
        subject: TEST_RECORD.subject,
        recordId: ID,
        attachmentId: 'a1',
        action: 'removed',
      }),
    );
    await screen.findByText('No files attached.');
    expect(screen.queryByText('virus.pdf')).toBeNull();
    const notification = {
      id: '0199a3f2-0000-7000-8000-000000000701',
      type: 'attachment.rejected',
      title: 'Your file was rejected',
      body: '“virus.pdf” was removed from TestItem: the malware scan flagged it (Eicar-Test-Signature).',
      data: {
        name: 'virus.pdf',
        subject: 'Elsewhere',
        signature: 'Eicar-Test-Signature',
      },
      link: null,
      key: null,
      count: 1,
      read: false,
      readAt: null,
      createdAt: '2026-10-21T10:00:00.000Z',
      updatedAt: '2026-10-21T10:00:00.000Z',
    };
    // Another subject's file is none of this page's business.
    act(() => fake.emit('notification', notification));
    await act(() => Promise.resolve());
    expect(screen.queryByText('Your file was rejected')).toBeNull();
    act(() =>
      fake.emit('notification', {
        ...notification,
        data: { ...notification.data, subject: TEST_RECORD.subject },
      }),
    );
    await findToast('Your file was rejected');
    expect(screen.getByText(/the malware scan flagged it/)).toBeVisible();
    // Other notifications are not toasted here.
    act(() =>
      fake.emit('notification', {
        ...notification,
        type: 'note.published',
        title: 'A note was published',
        data: { subject: TEST_RECORD.subject },
      }),
    );
    await act(() => Promise.resolve());
    expect(screen.queryByText('A note was published')).toBeNull();
  });

  it("drops a rejected file on the uploader's notification when the removed event does not reach them", async () => {
    // The uploader is no watcher of the record: `removed` (sent by the system
    // principal) goes to the watchers only; the notification is theirs.
    const calls = usePanelsApi({
      attachments: [
        {
          id: 'a1',
          name: 'virus.pdf',
          size: 2048,
          contentType: 'application/pdf',
          uploadedBy: ME,
          scanStatus: 'pending',
        },
      ],
    });
    await mountPanels(ALL);
    await open('Attachments');
    await screen.findByText('virus.pdf');
    const fake = await socket();
    act(() => fake.emit('connect'));
    calls.scanInfected('a1');
    act(() =>
      fake.emit('notification', {
        id: '0199a3f2-0000-7000-8000-000000000702',
        type: 'attachment.rejected',
        title: 'Your file was rejected',
        body: '“virus.pdf” was removed from TestItem: the malware scan flagged it (Eicar-Test-Signature).',
        data: {
          name: 'virus.pdf',
          subject: TEST_RECORD.subject,
          signature: 'Eicar-Test-Signature',
        },
        link: null,
        key: null,
        count: 1,
        read: false,
        readAt: null,
        createdAt: '2026-10-21T10:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
      }),
    );
    await findToast('Your file was rejected');
    await screen.findByText('No files attached.');
    expect(screen.queryByText('virus.pdf')).toBeNull();
  });
});

describe('the panels on a record', () => {
  it('shows only the panels the feature supports', async () => {
    usePanelsApi({ capabilities: { attachments: false, tags: false } });
    await mountPanels(ALL);
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
    const calls = usePanelsApi({
      capabilities: {
        comments: false,
        attachments: false,
        tags: false,
        revisions: false,
      },
    });
    await mountPanels(ALL);
    // Once the API has said what the subject takes.
    await waitFor(() => expect(calls.described).toBe(1));
    await act(() => Promise.resolve());
    nothingShown();
  });

  it('lists the records that refer to it, newest first, from their own list', async () => {
    usePanelsApi();
    const asked: URLSearchParams[] = [];
    server.use(
      http.get('/v1/lists/TestItem', () =>
        HttpResponse.json({
          ...panelsDescription(),
          related: [
            {
              subject: 'TestItem',
              path: 'test-items',
              field: 'parentId',
              title: 'title',
              required: false,
            },
          ],
        }),
      ),
      http.get('/v1/test-items', ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          items: [
            { id: 'c2', title: 'Second child', number: 'TI-2026-00002' },
            { id: 'c1', title: null, number: 'TI-2026-00001' },
          ],
          nextCursor: 'next',
          total: 12,
        });
      }),
    );
    await mountPanels(ALL);
    await open('Related');
    expect(await screen.findByText('Second child')).toBeVisible();
    // No title: its number.
    expect(screen.getByText('TI-2026-00001')).toBeVisible();
    expect(screen.getByText('The newest 2 of 12.')).toBeVisible();
    expect(asked[0]?.get('parentId')).toBe(ID);
    expect(asked[0]?.get('limit')).toBe('10');
  });

  it('shows nothing to a user who may not read the record', async () => {
    const calls = usePanelsApi();
    await mountPanels([]);
    nothingShown();
    // Nor asks what the subject takes (a 403).
    expect(calls.described).toBe(0);
  });
});
