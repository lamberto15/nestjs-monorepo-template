import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PreconditionFailedException,
  UseInterceptors,
} from '@nestjs/common';
import type { ApiHeaderOptions } from '@nestjs/swagger';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { map } from 'rxjs';

/**
 * Optimistic concurrency and caching with HTTP's own means (RFC 9110):
 *
 * - A route marked `@Etag()` answers with an `ETag`: a strong tag, the hash
 *   of the representation it sends (so a reader's tag covers what they may
 *   see). A `GET` with a matching `If-None-Match` gets 304 and no body.
 * - A write passes the `If-Match` it received to `assertUnchanged()` with
 *   the record as that caller would read it now: a tag that no longer
 *   matches is a 412 `precondition_failed`. Without `If-Match` the write
 *   goes ahead (clients opt in). `*` always matches.
 *
 * No version column: the tag is the representation, so any route that
 * returns a record can take part, with no migration.
 */

/** Where `untagged()` keeps the keys an object's tag leaves out: a symbol, so never in the JSON. */
const UNTAGGED = Symbol('keys the ETag leaves out');

/**
 * Marks keys of `value` its ETag leaves out, though the response carries
 * them: a record's `can` (`?include=can`) is about the reader's rights, not
 * the record (a record's `watching`, `?include=watching`, is about the
 * reader too; the GET's tag carries a marker of it, `etagOfResponse()`), so the tag of `GET /{id}?include=can` stays the one a write's
 * `If-Match` compares (`assertUnchanged()` with the record as shown, no
 * `can`). At any depth: a list's items too.
 */
export function untagged<T extends object>(value: T, keys: readonly string[]) {
  Object.defineProperty(value, UNTAGGED, { value: keys, enumerable: false });
  return value;
}

/** JSON.stringify's replacer: drops the keys their holder marked `untagged()`. */
function tagged(this: unknown, key: string, value: unknown) {
  const skip = (this as { [UNTAGGED]?: readonly string[] } | null)?.[UNTAGGED];
  return skip?.includes(key) ? undefined : value;
}

/** The strong ETag of a representation: a hash of its JSON, as the response carries it (less what `untagged()` marks). */
export const etagOf = (body: unknown) =>
  `"${createHash('sha256').update(JSON.stringify(body, tagged)).digest('base64url').slice(0, 27)}"`;

/** The length of a tag's hash: a `watching` marker follows it. */
const HASH_LENGTH = 27;

/**
 * A tag without its `watching` marker: what a write's `If-Match` compares
 * (a page read with `?include=watching` sends the tag it was given).
 */
const withoutMarker = (tag: string) =>
  tag.length > HASH_LENGTH + 2 ? `${tag.slice(0, HASH_LENGTH + 1)}"` : tag;

/**
 * The reader's `watching` flags a response carries (`?include=watching`:
 * a record's, or its list's items'), as a short hash, or undefined when it
 * carries none.
 */
function watchingMarker(body: object) {
  const own = body as { watching?: unknown; items?: unknown };
  const flags =
    typeof own.watching === 'boolean'
      ? [own.watching]
      : Array.isArray(own.items)
        ? (own.items as { watching?: unknown }[]).flatMap((item) =>
            typeof item?.watching === 'boolean' ? [item.watching] : [],
          )
        : [];
  return flags.length === 0
    ? undefined
    : createHash('sha256').update(flags.join()).digest('base64url').slice(0, 6);
}

/**
 * The ETag a GET sends: the representation's (`etagOf`), plus a marker of
 * the `watching` flags it carries. `watching` is the reader's, not the
 * record's, so it is not in the hash (a write's `If-Match` ignores the
 * marker, `assertUnchanged`), but it is in the tag, so a `304` happens only
 * while the flags are unchanged too: watch a record, read it again with
 * its old tag, and the answer is a 200 with `watching: true`.
 */
export function etagOfResponse(body: object) {
  const etag = etagOf(body);
  const marker = watchingMarker(body);
  return marker ? `${etag.slice(0, -1)}${marker}"` : etag;
}

/** The tags of an `If-Match` / `If-None-Match` header (`*` as itself); weak tags as their strong form. */
const tagsOf = (header: string | undefined) =>
  (header ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .filter(Boolean);

/**
 * Refuses a write when the caller's `If-Match` names a representation
 * other than `current` (the record as they would read it now): 412.
 */
export function assertUnchanged(ifMatch: string | undefined, current: object) {
  const given = tagsOf(ifMatch).map(withoutMarker);
  if (given.length === 0 || given.includes('*')) {
    return;
  }
  const etag = etagOf(current);
  if (!given.includes(etag)) {
    throw new PreconditionFailedException({
      code: 'precondition_failed',
      message:
        'The record changed since you read it: read it again, then retry with its ETag.',
      etag,
    });
  }
}

@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (
          body === null ||
          typeof body !== 'object' ||
          response.statusCode >= 300
        ) {
          return body;
        }
        const etag = etagOfResponse(body);
        response.setHeader('ETag', etag);
        // Cache, but ask again every time: a 304 is cheaper than the body.
        response.setHeader('Cache-Control', 'private, no-cache');
        if (
          request.method === 'GET' &&
          tagsOf(request.headers['if-none-match']).some(
            (tag) => tag === etag || tag === '*',
          )
        ) {
          response.status(304);
          return undefined;
        }
        return body;
      }),
    );
  }
}

/** Marks a route whose response gets an `ETag` (and 304 on a matching `If-None-Match`). */
export const Etag = () => UseInterceptors(EtagInterceptor);

/** The `If-Match` header, for a write's OpenAPI. */
export const ifMatchHeader = (): ApiHeaderOptions => ({
  name: 'If-Match',
  required: false,
  description:
    'The ETag the record had when you read it: the write is refused with 412 if it changed since (optimistic concurrency). Leave it out to write regardless; `*` means the same.',
  schema: { type: 'string', example: '"mZ1k…"' },
});

/** The `If-None-Match` header, for a read's OpenAPI. */
export const ifNoneMatchHeader = (): ApiHeaderOptions => ({
  name: 'If-None-Match',
  required: false,
  description: 'The ETag you have: 304 and no body when it is still current.',
  schema: { type: 'string', example: '"mZ1k…"' },
});
