import {
  etagOf,
  unwrap,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { recordKeys } from '@/lib/records';

/** The notes list route, as ListPage and the record keys name it. */
export const NOTES_PATH = '/v1/notes';

/**
 * The API's limits of a note's text (`maxLength` of `title` and `body` in
 * the create and update schemas). Constants rather than a read of
 * `@nestjs-monorepo-template/api-client/openapi.json` at run time, which
 * would put the whole 1 MB document into the bundle; notes.test.tsx checks
 * them against that document, so a change of the API fails the test.
 */
export const NOTE_LIMITS = { title: 200, body: 10_000 } as const;

/**
 * Each record says what the user may do with it now (`note.can`). The detail
 * also says whether they watch it (`note.watching`): notes take the `watch`
 * capability (note.record.ts), so the API accepts it; a feature without it
 * answers 400 to `watching`.
 */
const WITH_CAN = { include: 'can' };
const WITH_CAN_WATCHING = { include: 'can,watching' };

type Json<T> = T extends { content: { 'application/json': infer B } }
  ? B
  : never;

/** A note as one reader sees it: `body` is left out when their permissions don't include the text. */
export type Note = Json<paths['/v1/notes/{id}']['get']['responses'][200]>;
export type NoteCreate = NonNullable<
  paths['/v1/notes']['post']['requestBody']
>['content']['application/json'];
export type NoteChanges = NonNullable<
  paths['/v1/notes/{id}']['patch']['requestBody']
>['content']['application/json'];

/**
 * One note with the ETag it came with (`If-Match` of the next write). The
 * ETag is read from the response headers, which openapi-fetch returns next
 * to the data.
 */
export const noteQuery = (id: string) =>
  queryOptions({
    queryKey: recordKeys.detail(NOTES_PATH, id),
    queryFn: async () => {
      const result = await api.GET('/v1/notes/{id}', {
        params: { path: { id }, query: WITH_CAN_WATCHING },
      });
      return {
        note: await unwrap(Promise.resolve(result)),
        etag: etagOf(result),
      };
    },
    // A note this tab just created is in the cache with the create's ETag
    // (seedCreatedNote): it is not read again at once. It carries no `can`
    // (the create takes no `include`), which is how it is told apart; any
    // write invalidates it as usual.
    staleTime: (query) =>
      query.state.data && query.state.data.note.can === undefined
        ? CREATED_FRESH
        : 0,
    // RecordState says a 404 or a failure on the page (with a retry): not
    // a toast as well.
    meta: { errorToast: false },
  });

/** How long a just-created note is shown from the create's answer. */
const CREATED_FRESH = 30_000;

/** The list's query: each row with its `can` (see useRecordCan). */
export const NOTES_LIST_QUERY = WITH_CAN;
export const NOTES_BIN_QUERY = { ...WITH_CAN, deleted: 'true' };

/**
 * The client sends the Idempotency-Key of every POST itself. The answer's
 * ETag is the one `GET /v1/notes/{id}` would send, usable as `If-Match`.
 */
export const createNote = async (body: NoteCreate) => {
  const result = await api.POST('/v1/notes', { body });
  return {
    note: await unwrap(Promise.resolve(result)),
    etag: etagOf(result),
  };
};

/**
 * Puts a created note where its detail page reads it: no second request. Its
 * creator watches it from the start (the API subscribes the owner on create).
 */
export const seedCreatedNote = (
  queryClient: QueryClient,
  created: { note: Note; etag: string | undefined },
) =>
  queryClient.setQueryData(noteQuery(created.note.id).queryKey, {
    ...created,
    note: { ...created.note, watching: true },
  });

/** After a watch / unwatch: the cached note says so, without a read. */
export const setNoteWatching = (
  queryClient: QueryClient,
  id: string,
  watching: boolean,
) =>
  queryClient.setQueryData(
    noteQuery(id).queryKey,
    (cached) => cached && { ...cached, note: { ...cached.note, watching } },
  );

/** Only what is sent changes; with the ETag, a note changed meanwhile is a 412. */
export const updateNote = (id: string, body: NoteChanges, etag?: string) =>
  unwrap(
    api.PATCH('/v1/notes/{id}', {
      params: {
        path: { id },
        ...(etag && { header: { 'If-Match': etag } }),
      },
      body,
    }),
  );

export const deleteNote = (id: string) =>
  unwrap(api.DELETE('/v1/notes/{id}', { params: { path: { id } } }));

export const restoreNote = (id: string) =>
  unwrap(api.POST('/v1/notes/{id}/restore', { params: { path: { id } } }));
