import { http, HttpResponse } from 'msw/http';
import { problem, server, signedInUser } from '@/test/server';

// The record panels' routes (comments, attachments, tags, revisions, the
// people directory) under one record route, in memory. `panelHandlers()` with
// nothing given answers empty lists, which a record page needs; the panels'
// tests pass what they need and read `calls`. The route is the test-only
// subject's unless `record` names a feature's: no feature is assumed, so the
// shared tests stand without any (`pnpm feature:remove`).

/** The test-only subject's record route and subject, as RecordPanels takes them. */
export const TEST_RECORD = {
  subject: 'TestItem',
  path: '/v1/test-items/{id}',
} as const;

export const MAYA = {
  id: '0199a3f2-0000-7000-8000-000000000002',
  email: 'maya@example.com',
  name: 'Maya Patel',
};

/** What a subject takes, as `GET /v1/lists/{subject}` says it. */
export type PanelCapabilities = {
  comments: boolean;
  attachments: boolean;
  tags: boolean;
  revisions: boolean;
  /** PDF documents of the record; off unless a test asks. */
  pdf?: boolean;
  /** Watching the record (`…/{id}/watch`); off unless a test asks. */
  watch?: boolean;
};

export const EVERY_PANEL: PanelCapabilities = {
  comments: true,
  attachments: true,
  tags: true,
  revisions: true,
};

export const ATTACHMENT_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxMb: 25,
  types: ['image/png', 'application/pdf', 'text/plain'],
};

/**
 * The panels' part of `GET /v1/lists/{subject}`: a feature's test
 * description spreads it (`{ ...description, ...panelsDescription() }`).
 */
export function panelsDescription(
  capabilities: Partial<PanelCapabilities> = EVERY_PANEL,
  attachmentLimits: typeof ATTACHMENT_LIMITS | null = ATTACHMENT_LIMITS,
) {
  const all = { ...EVERY_PANEL, ...capabilities };
  return {
    capabilities: {
      ...all,
      pdf: all.pdf ?? false,
      bulk: false,
      watch: all.watch ?? false,
      search: false,
      transfer: false,
      custom: false,
      events: false,
      numbered: false,
      approvals: false,
    },
    attachmentLimits: all.attachments ? attachmentLimits : null,
  };
}

type Comment = {
  id: string;
  subject: string;
  recordId: string;
  author: string;
  authorName: string | null;
  body: string;
  mentions: string[];
  mentionNames: Record<string, string | null>;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TestRevision = {
  number: number;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  changedBy: string;
  changedByName?: string | null;
  restoredFrom?: number | null;
};

export const sampleRevisions: TestRevision[] = [
  {
    number: 3,
    changes: { title: { from: 'Q3', to: 'Q3 targets' } },
    changedBy: `user:${MAYA.id}`,
    changedByName: MAYA.name,
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
    /**
     * The record's route and subject (`{ subject: 'Invoice', path: '/v1/invoices/{id}' }`).
     * A feature's test serves its own `GET /v1/lists/{subject}` (with
     * `panelsDescription()`); the test-only subject's is served here.
     */
    record?: { subject: string; path: `${string}/{id}` };
    /** What the test-only subject takes (all four panels by default). */
    capabilities?: Partial<PanelCapabilities>;
    attachmentLimits?: typeof ATTACHMENT_LIMITS;
    /** The tenant's people, as `GET /v1/people?q=` searches them. */
    people?: (typeof MAYA)[];
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
  const { subject, path } = options.record ?? TEST_RECORD;
  // msw's form of the route: `/v1/test-items/:id`.
  const route = path.replace('{id}', ':id');
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
    /** The `q` of each `GET /v1/people` ('' without one). */
    peopleQueries: [] as string[],
    /** How often the test-only subject's `GET /v1/lists/{subject}` was asked. */
    described: 0,
  };
  const comments: Comment[] = (options.comments ?? []).map((c, i) => ({
    id: `c${i}`,
    subject,
    recordId: 'x',
    author: `user:${MAYA.id}`,
    authorName: MAYA.name,
    body: '',
    mentions: [],
    mentionNames: {},
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
    ...(options.record
      ? []
      : [
          http.get(`/v1/lists/${subject}`, () => {
            calls.described += 1;
            return HttpResponse.json(
              panelsDescription(options.capabilities, options.attachmentLimits),
            );
          }),
        ]),
    http.get('/v1/people', ({ request }) => {
      const query = new URL(request.url).searchParams;
      const q = query.get('q') ?? '';
      const keys = query.get('key')?.split(',');
      // `?key=` names these keys (an author's picture, the comments' names); `?q=` searches.
      if (keys) {
        return HttpResponse.json({
          items: [MAYA, ...(options.people ?? [])]
            .filter((p) => keys.includes(`user:${p.id}`))
            .map((p) => ({
              key: `user:${p.id}`,
              name: p.name,
              avatarUrl: null,
            })),
        });
      }
      calls.peopleQueries.push(q);
      return HttpResponse.json({
        items: (options.people ?? [])
          .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
          .map((p) => ({
            key: `user:${p.id}`,
            name: p.name,
            avatarUrl: null,
          })),
      });
    }),
    http.get('/v1/tags', () => page(options.tags ?? [])),
    http.post('/v1/tags', async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.tagsCreated.push(body);
      return HttpResponse.json(
        { id: `new-${body.name}`, name: body.name, color: null },
        { status: 201 },
      );
    }),
    http.get(`${route}/comments`, () => page(comments)),
    http.post(`${route}/comments`, async ({ params, request }) => {
      const body = (await request.json()) as { body: string };
      calls.commented.push({ id: params.id as string, body });
      const ids = [...body.body.matchAll(/@user:([0-9a-f-]{36})/g)].map(
        (m) => m[1]!,
      );
      const comment: Comment = {
        id: `n${comments.length}`,
        subject,
        recordId: params.id as string,
        author: `user:${signedInUser.user.id}`,
        authorName: signedInUser.user.name,
        body: body.body,
        mentions: ids.map((id) => `user:${id}`),
        // As the API answers: each mentioned person's name, null if unknown.
        mentionNames: Object.fromEntries(
          ids.map((id) => [
            `user:${id}`,
            (options.people ?? []).find((p) => p.id === id)?.name ?? null,
          ]),
        ),
        editedAt: null,
        createdAt: '2026-10-17T10:00:00.000Z',
        updatedAt: '2026-10-17T10:00:00.000Z',
      };
      comments.push(comment);
      return HttpResponse.json(comment, { status: 201 });
    }),
    http.patch(`${route}/comments/:commentId`, async ({ params, request }) => {
      const body = (await request.json()) as { body: string };
      calls.edited.push({ commentId: params.commentId as string, body });
      const comment = comments.find((c) => c.id === params.commentId)!;
      comment.body = body.body;
      comment.editedAt = '2026-10-17T10:05:00.000Z';
      return HttpResponse.json(comment);
    }),
    http.delete(`${route}/comments/:commentId`, ({ params }) => {
      calls.removedComments.push(params.commentId as string);
      comments.splice(
        comments.findIndex((c) => c.id === params.commentId),
        1,
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${route}/attachments`, () =>
      page(
        attachments.map((a) => ({
          subject,
          recordId: 'x',
          locked: false,
          createdAt: '2026-10-17T09:40:00.000Z',
          updatedAt: '2026-10-17T09:40:00.000Z',
          ...a,
        })),
      ),
    ),
    http.post(`${route}/attachments`, async ({ request }) => {
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
    http.put(`${route}/tags`, async ({ params, request }) => {
      const body = (await request.json()) as { tagIds: string[] };
      calls.tagged.push({ id: params.id as string, tagIds: body.tagIds });
      return HttpResponse.json({ items: [] });
    }),
    http.get(`${route}/revisions`, () =>
      page(
        revisions.map((r) => ({
          id: `r${r.number}`,
          subject,
          recordId: 'x',
          snapshot: {},
          restoredFrom: null,
          changedByName: null,
          changedAt: `2026-10-17T0${String(r.number)}:00:00.000Z`,
          createdAt: `2026-10-17T0${String(r.number)}:00:00.000Z`,
          updatedAt: `2026-10-17T0${String(r.number)}:00:00.000Z`,
          ...r,
        })),
      ),
    ),
    http.get(`${route}/revisions/:a/diff/:b`, ({ params }) => {
      calls.diffs.push(`${String(params.a)}-${String(params.b)}`);
      return HttpResponse.json({
        from: Number(params.a),
        to: Number(params.b),
        changes: { title: { from: 'Draft', to: 'Q3 targets' } },
      });
    }),
    http.post(`${route}/revisions/:number/restore`, ({ params, request }) => {
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

/** Serves the panels' routes for this test (over a record page's empty defaults). */
export function usePanelsApi(
  options: Parameters<typeof panelHandlers>[0] = {},
) {
  const { calls, handlers } = panelHandlers(options);
  server.use(...handlers);
  return calls;
}
