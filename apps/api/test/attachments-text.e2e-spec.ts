import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import { attachmentTexts } from '../src/platform/attachments/attachment-text.tables.js';
import { AttachmentTextRetryJob } from '../src/platform/attachments/attachment-text-retry.job.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: uploads get their text extracted.
vi.hoisted(() => {
  process.env.ATTACHMENT_TEXT_SEARCH = 'on';
});

describe('search inside attachments (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  /** The attachment's text row, once its job has run. */
  const extracted = (attachmentId: string) =>
    vi.waitFor(
      async () => {
        const [row] = await node.db
          .select()
          .from(attachmentTexts)
          .where(eq(attachmentTexts.attachmentId, attachmentId));
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 30_000, interval: 200 },
    );

  async function upload(content: Buffer | string, filename: string) {
    const editor = await node.user(['editor']);
    const item = (
      await node
        .writeItem(editor.agent, { title: 'Contracts', body: 'x' })
        .expect(201)
    ).body as { id: string };
    const added = (
      await editor.agent
        .post(`/v1/test-items/${item.id}/attachments`)
        .attach('file', Buffer.from(content), { filename })
        .expect(201)
    ).body as { id: string };
    return { editor, item, added };
  }

  type Agent = Awaited<ReturnType<TestApp['user']>>['agent'];

  const files = async (agent: Agent, q: string) =>
    (
      await agent
        .get('/v1/search')
        .query({ q, subject: 'Attachment' })
        .expect(200)
    ).body.items as {
      id: string;
      title: string;
      snippet: string | null;
      link: string | null;
    }[];

  it(
    'finds a file by its text, only for who may read its record now',
    { timeout: 60_000 },
    async () => {
      const { editor, item, added } = await upload(
        'The lease has a zebraquartz clause on page two.',
        'lease.txt',
      );
      expect(await extracted(added.id)).toMatchObject({ status: 'ready' });

      expect(await files(editor.agent, 'zebraquartz')).toEqual([
        expect.objectContaining({
          id: added.id,
          title: 'lease.txt',
          link: `/test-items/${item.id}`,
          snippet: expect.stringContaining('<b>zebraquartz</b>'),
        }),
      ]);
      // A viewer reads every item; another editor only their own; another tenant nothing.
      const viewer = await node.user(['viewer']);
      expect(await files(viewer.agent, 'zebraquartz')).toHaveLength(1);
      const stranger = await node.user(['editor']);
      expect(await files(stranger.agent, 'zebraquartz')).toEqual([]);
      const other = await node.otherTenant();
      expect(await files(other.admin, 'zebraquartz')).toEqual([]);

      // In the recycle bin, its files are out of the search too.
      await editor.agent.delete(`/v1/test-items/${item.id}`).expect(204);
      expect(await files(editor.agent, 'zebraquartz')).toEqual([]);
    },
  );

  it(
    'matches only the current file, extracts a replaced one again, and drops the text with the file',
    { timeout: 60_000 },
    async () => {
      const { editor, added } = await upload(
        'An old ocelotprism memo.',
        'memo.txt',
      );
      await extracted(added.id);
      expect(await files(editor.agent, 'ocelotprism')).toHaveLength(1);

      // A new file of the attachment: the old text no longer matches.
      const [row] = await node.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, added.id));
      const key = `${row!.key}.v2`;
      await node.app
        .get(StorageDisk)
        .put(key, Buffer.from('A new lynxharbor memo.'), {
          contentType: row!.contentType,
        });
      await node.db
        .update(attachments)
        .set({ key, updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where(eq(attachments.id, added.id));
      expect(await files(editor.agent, 'ocelotprism')).toEqual([]);

      // The retry job finds it without text for its file, and queues it.
      expect(
        await node.app.get(AttachmentTextRetryJob).run(new Date()),
      ).toBeGreaterThanOrEqual(1);
      await vi.waitFor(
        async () =>
          expect(await files(editor.agent, 'lynxharbor')).toHaveLength(1),
        { timeout: 30_000, interval: 200 },
      );

      await editor.agent.delete(`/v1/attachments/${added.id}`).expect(204);
      expect(
        await node.db
          .select()
          .from(attachmentTexts)
          .where(eq(attachmentTexts.attachmentId, added.id)),
      ).toEqual([]);
    },
  );

  it(
    'stores a file the extractor refuses as failed, without text',
    { timeout: 60_000 },
    async () => {
      const { added } = await upload('%PDF-1.4 nothing else', 'broken.pdf');
      expect(await extracted(added.id)).toMatchObject({
        status: 'failed',
        text: '',
      });
    },
  );
});
