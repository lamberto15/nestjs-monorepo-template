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
const INCLUDES = ['can'] as const;

/** What a request asked to include. */
export interface RecordInclude {
  can: boolean;
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

/** `@Query('include', IncludePipe)`: `?include=can` as `{ can: true }`; another value is a 400. */
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
    return { can: parsed.data.includes('can') };
  }
}

/** The `include` query parameter, for a record route's OpenAPI (`@ApiQuery(includeQuery())`). */
export const includeQuery = (): ApiQueryOptions => ({
  name: 'include',
  required: false,
  type: String,
  description:
    '`can`: each record says what you may do with it now (`can.update`, `can.delete`, `can.restore`), as its routes would decide: a false is the 403 they would answer. Left out, the records carry no `can`.',
  example: 'can',
});

/** The record actions `can` reports: update and delete, restore with a recycle bin. */
export const recordCanActions = (softDelete: boolean) =>
  softDelete
    ? (['update', 'delete', 'restore'] as const)
    : (['update', 'delete'] as const);

/** A record's `can` in its response schema: optional, there only with `?include=can`. */
export const recordCanSchema = (softDelete: boolean) =>
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
    })
    .optional()
    .describe(
      'What you may do with it now, as its routes would decide by your permissions and their conditions. Only with `?include=can`; not part of the ETag.',
    );

/** The fields a record's `can` is checked against: the row as stored. */
type CanRow = { id: string; deletedAt?: unknown } & Record<string, unknown>;

/**
 * `can` for each row, by id: each action is the policy's check of the route
 * that does it. `restore` only for a row in the recycle bin (the route
 * finds no other); a deleted row allows nothing else (AccessService.can).
 */
export async function recordCan(
  authorization: AuthorizationService,
  policy: Type,
  user: Principal,
  rows: readonly CanRow[],
  actions: readonly string[],
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
              await Promise.all(
                actions.map(async (action) => [
                  action,
                  action === 'restore' && row.deletedAt == null
                    ? false
                    : await can(policy, action, user, row),
                ]),
              ),
            ),
          ] as const,
      ),
    ),
  );
}

/**
 * The shown records with their `can` (by id), left out of their ETag
 * (`untagged()`): the tag stays the record's, the one `If-Match` compares.
 */
export function withCan<T extends Record<string, unknown>>(
  shown: T,
  can: Map<string, Record<string, boolean>>,
): T & { can?: Record<string, boolean> } {
  const flags = can.get(shown.id as string);
  return flags ? untagged({ ...shown, can: flags }, ['can']) : shown;
}
