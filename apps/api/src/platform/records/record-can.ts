import { Injectable, type PipeTransform, type Type } from '@nestjs/common';
import type { AuthorizationService } from '@nestjs/authorization';
import type { ApiQueryOptions } from '@nestjs/swagger';
import { z } from 'zod';
import { untagged } from '../../core/http/etag.js';
import { validationException } from '../../core/http/problem-details.filter.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * What a record says the reader may do with it now (`?include=can`): its
 * `can`, named like `GET /v1/auth/me`'s `can`, but per record. Each action
 * is the record's own policy check, the one its route makes before acting
 * (`AuthorizationService.can()`, the same conditions, the request's tenant
 * and principal, API clients included), so `can.update: false` is the 403
 * the PATCH would answer. Evaluated in memory with the reader's ability,
 * which the request has loaded already (cached per tenant and principal):
 * no query per row. Opt-in, so lists stay light.
 */

/** What `?include=` may ask for. */
const INCLUDES = ['can', 'watching'] as const;

/** What a request asked to include. */
export interface RecordInclude {
  can: boolean;
  /** `watching` (the `watch` capability): whether the reader watches each record. */
  watching: boolean;
}

const includeSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    [value ?? []]
      .flat()
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(INCLUDES)));

/** `@Query('include', IncludePipe)`: `?include=can,watching` as `{ can: true, watching: true }`; another value is a 400. */
@Injectable()
export class IncludePipe implements PipeTransform<unknown, RecordInclude> {
  transform(value: unknown): RecordInclude {
    const parsed = includeSchema.safeParse(value);
    if (!parsed.success) {
      throw validationException(
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ['include', ...issue.path],
        })),
      );
    }
    return {
      can: parsed.data.includes('can'),
      watching: parsed.data.includes('watching'),
    };
  }
}

/** The `include` query parameter, for a record route's OpenAPI (`@ApiQuery(includeQuery())`). */
export const includeQuery = (): ApiQueryOptions => ({
  name: 'include',
  required: false,
  type: String,
  description:
    '`can`: each record says what you may do with it now (`can.update`, `can.delete`, `can.restore`, `can.issue` where it takes PDFs), as its routes would decide: a false is the 403 (or 503) they would answer. `watching`: each record says whether you watch it (`watching: true`), where records can be watched; any other record type answers 400. Left out, the records carry neither. Combine them with a comma: `can,watching`.',
  example: 'can,watching',
});

/** The record actions `can` reports: update and delete, restore with a recycle bin. */
export const recordCanActions = (softDelete: boolean) =>
  softDelete
    ? (['update', 'delete', 'restore'] as const)
    : (['update', 'delete'] as const);

/**
 * A record's `can` in its response schema: optional, there only with
 * `?include=can`. `issue` for a subject that takes PDFs (the `pdf`
 * capability).
 */
export const recordCanSchema = (
  softDelete: boolean,
  { issue = false }: { issue?: boolean } = {},
) =>
  z
    .object({
      update: z.boolean().describe('PATCH would be allowed.'),
      delete: z.boolean().describe('DELETE would be allowed.'),
      ...(softDelete && {
        restore: z
          .boolean()
          .describe(
            'It is in the recycle bin and POST …/{id}/restore would be allowed.',
          ),
      }),
      ...(issue && {
        issue: z
          .boolean()
          .describe(
            'POST …/{id}/pdf would be accepted: you may read it, its document source lets you issue it, and documents are on (false without GOTENBERG_URL, where the route answers 503).',
          ),
      }),
    })
    .optional()
    .describe(
      'What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag.',
    );

/**
 * A record's `watching` in its response schema (the `watch` capability):
 * optional, there only with `?include=watching`.
 */
export const recordWatchingSchema = z
  .boolean()
  .optional()
  .describe(
    'Whether you watch it (POST …/{id}/watch): you are told when it changes. Only with `?include=watching`; not part of the ETag.',
  );

/** The fields a record's `can` is checked against: the row as stored. */
export type CanRow = { id: string; deletedAt?: unknown } & Record<
  string,
  unknown
>;

/**
 * A `can` flag that is not one policy action (`issue`): `check` is the
 * policy's check of an action on the row, as the other flags use it.
 */
export type CanFlag = (
  row: CanRow,
  check: (action: string) => Promise<boolean>,
) => Promise<boolean>;

/**
 * `can` for each row, by id: each action is the policy's check of the route
 * that does it. `restore` only for a row in the recycle bin (the route
 * finds no other); a deleted row allows nothing else (AccessService.can).
 * `flags` add those that are not one action (`issue`: issueFlag()).
 */
export async function recordCan(
  authorization: AuthorizationService,
  policy: Type,
  user: Principal,
  rows: readonly CanRow[],
  actions: readonly string[],
  flags: Record<string, CanFlag> = {},
): Promise<Map<string, Record<string, boolean>>> {
  // The action is a string here, not one of a known policy's literals.
  const can = authorization.can.bind(authorization) as (
    policy: Type,
    ability: string,
    user: Principal,
    row: CanRow,
  ) => Promise<boolean>;
  return new Map(
    await Promise.all(
      rows.map(
        async (row) =>
          [
            row.id,
            Object.fromEntries(
              await Promise.all([
                ...actions.map(async (action) => [
                  action,
                  action === 'restore' && row.deletedAt == null
                    ? false
                    : await can(policy, action, user, row),
                ]),
                ...Object.entries(flags).map(async ([name, flag]) => [
                  name,
                  await flag(row, (action) => can(policy, action, user, row)),
                ]),
              ]),
            ),
          ] as const,
      ),
    ),
  );
}

/**
 * The shown record with what `?include=` asked for: its `can` (by id) and
 * its `watching` (the ids the reader watches). Left out of its ETag
 * (`untagged()`): the tag stays the record's, the one `If-Match` compares.
 */
export function withIncluded<T extends Record<string, unknown>>(
  shown: T,
  included: {
    can?: Map<string, Record<string, boolean>>;
    watching?: Set<string>;
  },
): T & { can?: Record<string, boolean>; watching?: boolean } {
  const id = shown.id as string;
  const extra: { can?: Record<string, boolean>; watching?: boolean } = {};
  const can = included.can?.get(id);
  if (can) {
    extra.can = can;
  }
  if (included.watching) {
    extra.watching = included.watching.has(id);
  }
  const keys = Object.keys(extra);
  return keys.length ? untagged({ ...shown, ...extra }, keys) : shown;
}

/** `withIncluded()` with only a `can`. */
export const withCan = <T extends Record<string, unknown>>(
  shown: T,
  can: Map<string, Record<string, boolean>>,
) => withIncluded(shown, { can });
