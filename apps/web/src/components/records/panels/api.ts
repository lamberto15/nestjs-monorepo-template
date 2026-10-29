import {
  ApiError,
  etagOf,
  unwrap,
  type components,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import { postMultipart, putFile, StoreUnreachableError } from '@/lib/upload';

/**
 * The record panels' routes (docs/comments.md, attachments.md, tags.md,
 * revisions.md). Every feature that registers a target has the same routes
 * under its own path, with the same shapes; the generated client types them
 * per feature, so the types below are those routes' answers, whichever
 * features have them. No feature's path is named here: `pnpm feature:remove`
 * may take any of them, the last one included. (Named schemas in the client,
 * #157, would type them without any feature.)
 *
 * `base` is the record's route, `/v1/<plural>/{id}`.
 */
type Suffix =
  | '/comments'
  | '/comments/{commentId}'
  | '/attachments'
  | '/attachments/presign'
  | '/attachments/complete'
  | '/tags'
  | '/pdf'
  | '/watch'
  | '/revisions'
  | '/revisions/{number}/restore'
  | '/revisions/{a}/diff/{b}'
  | '/duplicates'
  | '/merge'
  | '/merge/preview';

/** Every feature's route ending in the suffix (`/v1/<plural>/{id}/comments`). */
type At<S extends Suffix> = Extract<keyof paths, `/v1/${string}/{id}${S}`>;

type Json<T> = T extends { content: { 'application/json': infer B } }
  ? B
  : never;

/**
 * The 200 answer of `GET <base><suffix>`. With no feature keeping the route
 * (none has comments, say), nothing renders its panel: `any` then only lets
 * this module and the panels compile.
 */
type Answer<S extends Suffix> = [At<S>] extends [never]
  ? any
  : paths[At<S>] extends { get: { responses: { 200: infer R } } }
    ? Json<R>
    : never;

export type Comment = Answer<'/comments'>['items'][number];
export type Attachment = Answer<'/attachments'>['items'][number];
type PresignedUpload = components['schemas']['PresignedUpload'];
export type Revision = Answer<'/revisions'>['items'][number];
export type RevisionDiff = Answer<'/revisions/{a}/diff/{b}'>;
export type Duplicate = components['schemas']['Duplicate'];
export type MergePreview = components['schemas']['MergePreview'];

type Init = {
  params: {
    path: Record<string, string | number>;
    query?: Record<string, string | number | undefined>;
    header?: Record<string, string>;
  };
  body?: unknown;
};
type Call = (
  path: string,
  init: Init,
) => Promise<{ data?: unknown; response: Response }>;

/**
 * The client for these routes. openapi-fetch types a call by its literal
 * path, and these hang off any feature's path (or none's): one cast, as
 * lib/list-query.ts's fetchPage and features/bulk do; the answers are typed
 * by the functions below.
 */
const client = api as unknown as Record<
  'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  Call
>;

/** `GET`, `POST`… on `<base><suffix>`, answering `T`. */
const call = <T>(
  method: keyof typeof client,
  base: string,
  suffix: Suffix,
  init: Init,
) =>
  client[method](`${base}${suffix}`, init) as Promise<{
    data?: T;
    response: Response;
  }>;

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
  document: (id: string) => ['panels', 'document', id] as const,
  duplicates: (base: string, id: string) =>
    ['panels', base, id, 'duplicates'] as const,
  related: (base: string, id: string, path: string, field: string) =>
    ['panels', base, id, 'related', path, field] as const,
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

type Page<T> = { items: T[]; nextCursor?: string | null };

/** The thread, oldest first (the newest last). */
export const listComments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Page<Comment>>('GET', base, '/comments', {
        params: {
          path: { id },
          query: { limit: PAGE_SIZE, sort: 'createdAt', cursor },
        },
      }),
    ),
  );

export const addComment = (base: string, id: string, body: string) =>
  unwrap(
    call<Comment>('POST', base, '/comments', {
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
    call<Comment>('PATCH', base, '/comments/{commentId}', {
      params: { path: { id, commentId } },
      body: { body },
    }),
  );

export const removeComment = (base: string, id: string, commentId: string) =>
  unwrap(
    call<unknown>('DELETE', base, '/comments/{commentId}', {
      params: { path: { id, commentId } },
    }),
  );

export const listAttachments = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Page<Attachment>>('GET', base, '/attachments', {
        params: { path: { id }, query: { limit: PAGE_SIZE, cursor } },
      }),
    ),
  );

/** The first records a related panel shows; the rest are on their list. */
export const RELATED_LIMIT = 10;

/**
 * The newest records that refer to one, with how many there are: their
 * own list filtered by the reference (`related` of GET /v1/lists/{subject}),
 * which shows only those the user may read.
 */
export const listRelated = (path: string, field: string, id: string) =>
  unwrap(
    client.GET(`/v1/${path}`, {
      params: {
        path: {},
        query: { [field]: id, limit: RELATED_LIMIT, count: 'true' },
      },
    }) as Promise<{
      data?: { items: Record<string, unknown>[]; total?: number | null };
      response: Response;
    }>,
  );

/** The most records a record picker offers at once: type more to narrow them. */
export const PICKER_LIMIT = 20;
/** The longest `q` a list takes (a longer one is a 400). */
const MAX_TERM = 200;

/**
 * The records of a list a reference may name, for a picker: those matching
 * `term` by its search (`q`, the `search` capability), else the newest,
 * PICKER_LIMIT of them. The list shows only those the user may read.
 */
export const searchRecords = (path: string, term: string) => {
  const q = term.trim().slice(0, MAX_TERM);
  return unwrap(
    client.GET(`/v1/${path}`, {
      params: {
        path: {},
        query: { limit: PICKER_LIMIT, ...(q && { q }) },
      },
    }) as Promise<{
      data?: { items: Record<string, unknown>[] };
      response: Response;
    }>,
  );
};

/** A record's likely duplicates (docs/merging.md): those the user may read. */
export const listDuplicates = (base: string, id: string) =>
  unwrap(
    call<components['schemas']['DuplicateList']>('GET', base, '/duplicates', {
      params: { path: { id } },
    }),
  );

/**
 * The records a create or edit would duplicate (`POST <list>/duplicates`),
 * before it is saved: `listPath` is `/v1/<plural>`, `excludeId` the record
 * being edited.
 */
export const findDuplicates = (
  listPath: string,
  body: { values: Record<string, unknown>; excludeId?: string },
) =>
  unwrap(
    client.POST(`${listPath}/duplicates`, {
      params: { path: {} },
      body,
    }) as Promise<{
      data?: components['schemas']['DuplicateList'];
      response: Response;
    }>,
  );

/** Whose value each field keeps: the duplicate's where `duplicate`. */
export type MergeBody = {
  duplicateId: string;
  fields: Record<string, 'survivor' | 'duplicate'>;
};

/** What merging `duplicateId` into the record would do; changes nothing. */
export const previewMerge = (base: string, id: string, body: MergeBody) =>
  unwrap(
    call<MergePreview>('POST', base, '/merge/preview', {
      params: { path: { id } },
      body,
    }),
  );

/** Merges `duplicateId` into the record: the duplicate goes to the recycle bin. */
export const mergeRecord = (base: string, id: string, body: MergeBody) =>
  unwrap(
    call<Record<string, unknown>>('POST', base, '/merge', {
      params: { path: { id } },
      body,
    }),
  );

/** `GET /v1/attachments/{id}/download` redirects to a signed link: a plain link follows it. */
export const downloadUrl = (attachmentId: string) =>
  `/v1/attachments/${attachmentId}/download`;

/**
 * An image's smaller copy (`thumb` 256 px, `preview` 1600 px, WebP: docs/attachments.md,
 * "Image renditions"). Like the download, it redirects to a signed link, which an
 * `<img>` follows only to an origin the page may load images from (the dev proxy,
 * Caddy's `img-src`: docs/attachments.md). 404 while the image is not `ready`.
 */
export const renditionUrl = (
  attachmentId: string,
  rendition: 'thumb' | 'preview',
) => `${downloadUrl(attachmentId)}?rendition=${rendition}`;

export const removeAttachment = (attachmentId: string) =>
  unwrap(
    api.DELETE('/v1/attachments/{id}', {
      params: { path: { id: attachmentId } },
    }),
  );

/**
 * Uploads one file with progress for the dropzone (docs/attachments.md).
 *
 * `direct` (`GET /v1/features`: `presignedUploads`, `STORAGE_DRIVER=s3`): the
 * file goes straight to the object store, which spares the API its bytes:
 * `…/attachments/presign` for a signed URL, a PUT of the file to it, then
 * `…/attachments/complete`, which attaches it after the server checked what
 * arrived. Otherwise, and whenever a direct upload cannot be tried (the
 * browser cannot name the file's type, which a signed URL is bound to; the
 * server answered 503 `presigned_uploads_unavailable` meanwhile, or 429
 * `attachment_uploads_pending`; the browser cannot reach the store, say a
 * bucket with no CORS rule for this origin),
 * the file goes as multipart through the API, which works with every driver.
 */
export async function uploadAttachment(
  base: string,
  id: string,
  file: File,
  onProgress: (percent: number) => void,
  direct = false,
): Promise<Attachment> {
  if (direct && file.type) {
    try {
      return await uploadDirect(base, id, file, onProgress);
    } catch (error) {
      // The multipart upload leaves no announcement behind, so a user who
      // has many open (attachment_uploads_pending) can still attach files.
      const fallback =
        error instanceof StoreUnreachableError ||
        (error instanceof ApiError &&
          (error.code === 'presigned_uploads_unavailable' ||
            error.code === 'attachment_uploads_pending'));
      if (!fallback) throw error;
      onProgress(0);
    }
  }
  const form = new FormData();
  form.append('file', file);
  return postMultipart<Attachment>(
    `${base}/attachments`.replace('{id}', id),
    form,
    onProgress,
  );
}

async function uploadDirect(
  base: string,
  id: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<Attachment> {
  const upload = await unwrap(
    call<PresignedUpload>('POST', base, '/attachments/presign', {
      params: { path: { id } },
      body: { name: file.name, size: file.size, contentType: file.type },
    }),
  );
  await putFile(upload.url, upload.headers, file, onProgress);
  return unwrap(
    call<Attachment>('POST', base, '/attachments/complete', {
      params: { path: { id } },
      body: { uploadId: upload.uploadId },
    }),
  );
}

/** Watch the record: its owner and watchers are told of changes (docs/notifications.md). */
export const watchRecord = (base: string, id: string) =>
  unwrap(
    call<{ watching: boolean }>('POST', base, '/watch', {
      params: { path: { id } },
    }),
  );

/** Stop watching it (404 when it was not watched). */
export const unwatchRecord = (base: string, id: string) =>
  unwrap(call<unknown>('DELETE', base, '/watch', { params: { path: { id } } }));

export const setTags = (base: string, id: string, tagIds: string[]) =>
  unwrap(
    call<unknown>('PUT', base, '/tags', {
      params: { path: { id } },
      body: { tagIds },
    }),
  );

export const listRevisions = (base: string, id: string) =>
  allPages((cursor) =>
    unwrap(
      call<Page<Revision>>('GET', base, '/revisions', {
        params: { path: { id }, query: { limit: PAGE_SIZE, cursor } },
      }),
    ),
  );

export const diffRevisions = (base: string, id: string, a: number, b: number) =>
  unwrap(
    call<RevisionDiff>('GET', base, '/revisions/{a}/diff/{b}', {
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
  const result = await call<unknown>(
    'POST',
    base,
    '/revisions/{number}/restore',
    {
      params: {
        path: { id, number },
        ...(etag && { header: { 'If-Match': etag } }),
      },
    },
  );
  return {
    record: await unwrap(Promise.resolve(result)),
    etag: etagOf(result),
  };
}

/**
 * Asks for the record's PDF in `lang` (`POST <base>/pdf?lang=`, docs/documents.md):
 * 202 with the document's id, a worker renders it. A new `Idempotency-Key`
 * goes with every POST (the client); asking again is a new document.
 */
export const issueDocument = (base: string, id: string, lang: string) =>
  unwrap(
    call<{ id: string; status: 'queued' }>('POST', base, '/pdf', {
      params: { path: { id }, query: { lang } },
    }),
  );

/** `GET /v1/documents/{id}`: the job's state, then the issued PDF. */
export const documentStatus = (id: string) =>
  unwrap(api.GET('/v1/documents/{id}', { params: { path: { id } } }));
