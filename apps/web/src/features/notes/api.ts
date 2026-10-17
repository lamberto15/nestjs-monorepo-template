import {
  etagOf,
  unwrap,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { recordKeys } from '@/lib/records';

/** The notes list route, as ListPage and the record keys name it. */
export const NOTES_PATH = '/v1/notes';

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
        params: { path: { id } },
      });
      return {
        note: await unwrap(Promise.resolve(result)),
        etag: etagOf(result),
      };
    },
  });

/** The client sends the Idempotency-Key of every POST itself. */
export const createNote = (body: NoteCreate) =>
  unwrap(api.POST('/v1/notes', { body }));

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
