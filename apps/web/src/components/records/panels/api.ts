import {
  etagOf,
  unwrap,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import { postMultipart } from '@/lib/upload';

/**
 * The record panels' routes (docs/comments.md, attachments.md, tags.md,
 * revisions.md). Every feature that registers a target has the same routes
 * under its own path, with the same shapes; the generated client types them
 * per feature, so the Note's types stand for all and `at()` is the one cast.
 *
 * `base` is the record's route, `/v1/notes/{id}`.
 */
type Suffix =
  | '/comments'
  | '/comments/{commentId}'
  | '/attachments'
  | '/tags'
  | '/revisions'
  | '/revisions/{number}/restore'
  | '/revisions/{a}/diff/{b}';

type NotePath<S extends Suffix> = `/v1/notes/{id}${S}` & keyof paths;

function at<S extends Suffix>(base: string, suffix: S): NotePath<S> {
  // Same shapes under any feature's path; openapi-fetch only fills the
  // `{…}` parameters, so the Note's literal type stands for the others.
  return `${base}${suffix}` as NotePath<S>;
}

type Json<T> = T extends { content: { 'application/json': infer B } }
  ? B
  : never;

export type Comment = Json<
  paths['/v1/notes/{id}/comments']['get']['responses'][200]
>['items'][number];
export type Attachment = Json<
  paths['/v1/notes/{id}/attachments']['get']['responses'][200]
>['items'][number];
export type Revision = Json<
  paths['/v1/notes/{id}/revisions']['get']['responses'][200]
>['items'][number];
export type RevisionDiff = Json<
  paths['/v1/notes/{id}/revisions/{a}/diff/{b}']['get']['responses'][200]
>;

/** Pages of 100, at most 10: far past what a thread or a list can use. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export const panelKeys = {
  all: (base: string, id: string) => ['panels', base, id] as const,
  comments: (base: string, id: string) =>
    ['panels', base, id, 'comments'] as const,
  attachments: (base: string, id: string) =>
    ['panels', base, id, 'attachments'] as const,
  revisions: (base: string, id: string) =>
    ['panels', base, id, 'revisions'] as const,
  diff: (base: string, id: string, a: number, b: number) =>
    ['panels', base, id, 'revisions', 'diff', a, b] as const,
};

async function allPages<T>(
  page: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor?: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const result = await page(cursor);
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

/** The thread, oldest first (the newest last). */
export const listComments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      api.GET(at(base, '/comments'), {
        params: {
          path: { id },
          query: { limit: String(PAGE_SIZE), sort: 'createdAt', cursor },
        },
      }),
    ),
  );

export const addComment = (base: string, id: string, body: string) =>
  unwrap(
    api.POST(at(base, '/comments'), {
      params: { path: { id } },
      body: { body },
    }),
  );

export const editComment = (
  base: string,
  id: string,
  commentId: string,
  body: string,
) =>
  unwrap(
    api.PATCH(at(base, '/comments/{commentId}'), {
      params: { path: { id, commentId } },
      body: { body },
    }),
  );

export const removeComment = (base: string, id: string, commentId: string) =>
  unwrap(
    api.DELETE(at(base, '/comments/{commentId}'), {
      params: { path: { id, commentId } },
    }),
  );

export const listAttachments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      api.GET(at(base, '/attachments'), {
        params: { path: { id }, query: { limit: PAGE_SIZE, cursor } },
      }),
    ),
  );

/** `GET /v1/attachments/{id}/download` redirects to a signed link: a plain link follows it. */
export const downloadUrl = (attachmentId: string) =>
  `/v1/attachments/${attachmentId}/download`;

export const removeAttachment = (attachmentId: string) =>
  unwrap(
    api.DELETE('/v1/attachments/{id}', {
      params: { path: { id: attachmentId } },
    }),
  );

/**
 * Uploads one file (multipart, the field `file`: docs/attachments.md; the API
 * has no presigned upload), with progress for the dropzone.
 */
export function uploadAttachment(
  base: string,
  id: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<Attachment> {
  const form = new FormData();
  form.append('file', file);
  return postMultipart<Attachment>(
    at(base, '/attachments').replace('{id}', id),
    form,
    onProgress,
  );
}

export const setTags = (base: string, id: string, tagIds: string[]) =>
  unwrap(
    api.PUT(at(base, '/tags'), { params: { path: { id } }, body: { tagIds } }),
  );

export const listRevisions = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      api.GET(at(base, '/revisions'), {
        params: { path: { id }, query: { limit: String(PAGE_SIZE), cursor } },
      }),
    ),
  );

export const diffRevisions = (base: string, id: string, a: number, b: number) =>
  unwrap(
    api.GET(at(base, '/revisions/{a}/diff/{b}'), {
      params: { path: { id, a, b } },
    }),
  );

/** With the record's ETag, a record changed meanwhile is a 412. */
export async function restoreRevision(
  base: string,
  id: string,
  number: number,
  etag?: string,
) {
  const result = await api.POST(at(base, '/revisions/{number}/restore'), {
    params: {
      path: { id, number },
      ...(etag && { header: { 'If-Match': etag } }),
    },
  });
  return {
    record: await unwrap(Promise.resolve(result)),
    etag: etagOf(result),
  };
}
