import { http, HttpResponse } from 'msw/http';
import { principalsHandler, userPrincipal } from '@/test/principals';
import { problem, server, signedInUser } from '@/test/server';

// The record panels' routes for a Note (comments, attachments, tags,
// revisions, the user directory), in memory. `panelHandlers()` with nothing
// given answers empty lists, which the note page needs; the panels' tests
// pass what they need and read `calls`.

const NOTE = '/v1/notes/:id';

export const MAYA = {
  id: '0199a3f2-0000-7000-8000-000000000002',
  email: 'maya@example.com',
  name: 'Maya Patel',
};

type Comment = {
  id: string;
  subject: 'Note';
  recordId: string;
  author: string;
  body: string;
  mentions: string[];
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TestRevision = {
  number: number;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  changedBy: string;
  restoredFrom?: number | null;
};

export const sampleRevisions: TestRevision[] = [
  {
    number: 3,
    changes: { title: { from: 'Q3', to: 'Q3 targets' } },
    changedBy: `user:${MAYA.id}`,
  },
  {
    number: 2,
    changes: {
      title: { from: 'Draft', to: 'Q3' },
      body: { from: 'a', to: 'Renewals first.' },
    },
    changedBy: `user:${signedInUser.user.id}`,
  },
  { number: 1, changes: null, changedBy: `user:${signedInUser.user.id}` },
];

export function panelHandlers(
  options: {
    users?: (typeof MAYA)[] | 'forbidden';
    comments?: Partial<Comment>[];
    attachments?: {
      id: string;
      name: string;
      size: number;
      contentType: string;
      uploadedBy: string;
      locked?: boolean;
    }[];
    tags?: { id: string; name: string; color: string | null }[];
    revisions?: TestRevision[];
    /** The ETag the restore must carry; another is a 412. */
    restoreEtag?: string;
    uploadStatus?: number;
  } = {},
) {
  const calls = {
    commented: [] as { id: string; body: unknown }[],
    edited: [] as { commentId: string; body: unknown }[],
    removedComments: [] as string[],
    uploaded: [] as { name: string; type: string; size: number }[],
    removedAttachments: [] as string[],
    tagged: [] as { id: string; tagIds: string[] }[],
    tagsCreated: [] as unknown[],
    restored: [] as { number: string; ifMatch: string | null }[],
    diffs: [] as string[],
  };
  const comments: Comment[] = (options.comments ?? []).map((c, i) => ({
    id: `c${i}`,
    subject: 'Note',
    recordId: 'x',
    author: `user:${MAYA.id}`,
    body: '',
    mentions: [],
    editedAt: null,
    createdAt: '2026-10-17T09:30:00.000Z',
    updatedAt: '2026-10-17T09:30:00.000Z',
    ...c,
  }));
  const attachments = [...(options.attachments ?? [])];
  const revisions = options.revisions ?? [];
  const page = (items: unknown[]) =>
    HttpResponse.json({ items, nextCursor: null });

  const handlers = [
    principalsHandler(
      options.users === 'forbidden'
        ? 'forbidden'
        : (options.users ?? []).map(userPrincipal),
    ),
    http.get('/v1/tags', () => page(options.tags ?? [])),
    http.post('/v1/tags', async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.tagsCreated.push(body);
      return HttpResponse.json(
        { id: `new-${body.name}`, name: body.name, color: null },
        { status: 201 },
      );
    }),
    http.get(`${NOTE}/comments`, () => page(comments)),
    http.post(`${NOTE}/comments`, async ({ params, request }) => {
      const body = (await request.json()) as { body: string };
      calls.commented.push({ id: params.id as string, body });
      const comment: Comment = {
        id: `n${comments.length}`,
        subject: 'Note',
        recordId: params.id as string,
        author: `user:${signedInUser.user.id}`,
        body: body.body,
        mentions: [],
        editedAt: null,
        createdAt: '2026-10-17T10:00:00.000Z',
        updatedAt: '2026-10-17T10:00:00.000Z',
      };
      comments.push(comment);
      return HttpResponse.json(comment, { status: 201 });
    }),
    http.patch(`${NOTE}/comments/:commentId`, async ({ params, request }) => {
      const body = (await request.json()) as { body: string };
      calls.edited.push({ commentId: params.commentId as string, body });
      const comment = comments.find((c) => c.id === params.commentId)!;
      comment.body = body.body;
      comment.editedAt = '2026-10-17T10:05:00.000Z';
      return HttpResponse.json(comment);
    }),
    http.delete(`${NOTE}/comments/:commentId`, ({ params }) => {
      calls.removedComments.push(params.commentId as string);
      comments.splice(
        comments.findIndex((c) => c.id === params.commentId),
        1,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${NOTE}/attachments`, () =>
      page(
        attachments.map((a) => ({
          subject: 'Note',
          recordId: 'x',
          locked: false,
          createdAt: '2026-10-17T09:40:00.000Z',
          updatedAt: '2026-10-17T09:40:00.000Z',
          ...a,
        })),
      ),
    ),
    http.post(`${NOTE}/attachments`, async ({ request }) => {
      if (options.uploadStatus && options.uploadStatus >= 400) {
        return problem(options.uploadStatus, 'unsupported_media_type');
      }
      // The raw multipart text: jsdom's File is not undici's, so
      // `request.formData()` cannot read what the page sent.
      const raw = await request.text();
      const name = /filename="([^"]*)"/.exec(raw)?.[1] ?? '';
      const type = /Content-Type: ([^\r\n]+)/i.exec(raw)?.[1] ?? '';
      const content = raw.split(/\r?\n\r?\n/)[1]?.split(/\r?\n--/)[0] ?? '';
      const file = { name, type, size: content.length };
      calls.uploaded.push(file);
      const added = {
        id: `a${attachments.length}`,
        name: file.name,
        size: file.size,
        contentType: file.type,
        uploadedBy: `user:${signedInUser.user.id}`,
      };
      attachments.push(added);
      return HttpResponse.json(added, { status: 201 });
    }),
    http.delete('/v1/attachments/:id', ({ params }) => {
      calls.removedAttachments.push(params.id as string);
      attachments.splice(
        attachments.findIndex((a) => a.id === params.id),
        1,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.put(`${NOTE}/tags`, async ({ params, request }) => {
      const body = (await request.json()) as { tagIds: string[] };
      calls.tagged.push({ id: params.id as string, tagIds: body.tagIds });
      return HttpResponse.json({ items: [] });
    }),
    http.get(`${NOTE}/revisions`, () =>
      page(
        revisions.map((r) => ({
          id: `r${r.number}`,
          subject: 'Note',
          recordId: 'x',
          snapshot: {},
          restoredFrom: null,
          changedAt: `2026-10-17T0${String(r.number)}:00:00.000Z`,
          createdAt: `2026-10-17T0${String(r.number)}:00:00.000Z`,
          updatedAt: `2026-10-17T0${String(r.number)}:00:00.000Z`,
          ...r,
        })),
      ),
    ),
    http.get(`${NOTE}/revisions/:a/diff/:b`, ({ params }) => {
      calls.diffs.push(`${String(params.a)}-${String(params.b)}`);
      return HttpResponse.json({
        from: Number(params.a),
        to: Number(params.b),
        changes: { title: { from: 'Draft', to: 'Q3 targets' } },
      });
    }),
    http.post(`${NOTE}/revisions/:number/restore`, ({ params, request }) => {
      const ifMatch = request.headers.get('if-match');
      calls.restored.push({ number: params.number as string, ifMatch });
      if (options.restoreEtag && ifMatch !== options.restoreEtag) {
        return problem(412, 'precondition_failed');
      }
      return HttpResponse.json({}, { headers: { etag: '"restored"' } });
    }),
  ];
  return { calls, handlers };
}

/** Serves the panels' routes for this test (over notes-api's empty defaults). */
export function usePanelsApi(
  options: Parameters<typeof panelHandlers>[0] = {},
) {
  const { calls, handlers } = panelHandlers(options);
  server.use(...handlers);
  return calls;
}
