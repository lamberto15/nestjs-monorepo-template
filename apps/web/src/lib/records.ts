import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useMe } from '@/lib/features';

const listRoot = ['list'] as const;
const recordRoot = ['record'] as const;

/**
 * What every feature's record pages share (the pattern docs/monorepo.md,
 * "Record pages", describes): the query keys, so a write invalidates the lists
 * and the record it changed, and the two problems pages branch on.
 *
 * `path` is the feature's list route (`/v1/<plural>`), as in ListPage.
 */
export const recordKeys = {
  /** Every list of every feature: the prefix of `list`'s key, for what reaches records of any feature. */
  allLists: listRoot,
  /** Every record of every feature: the prefix of `detail`'s key. */
  allDetails: recordRoot,
  /** One page of the feature's list: ListPage's key (`pathParams` for a nested route). */
  list: (
    path: string,
    params: unknown,
    pathParams?: Readonly<Record<string, string>>,
  ) =>
    pathParams
      ? ([...listRoot, path, params, pathParams] as const)
      : ([...listRoot, path, params] as const),
  /** Every page of the feature's list. */
  lists: (path: string) => [...listRoot, path] as const,
  /** One record, with its ETag. */
  detail: (path: string, id: string) => [...recordRoot, path, id] as const,
  /** Every record of the feature. */
  details: (path: string) => [...recordRoot, path] as const,
};

/** 412 `precondition_failed`: the record changed since its ETag was read. */
export function isPreconditionFailed(error: unknown): boolean {
  return isApiError(error) && error.status === 412;
}

/** 404: the record does not exist (or is not the caller's to see). */
export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** Refreshes the feature's lists and records after a write. */
export function useInvalidateRecords(path: string) {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: recordKeys.lists(path) }),
        queryClient.invalidateQueries({ queryKey: recordKeys.details(path) }),
      ]),
    [queryClient, path],
  );
}

/** A record's `can` (`?include=can`): `restore` is true only in the bin. */
export type RecordCan = { update: boolean; delete: boolean; restore: boolean };

/**
 * What the user may do with one record now: its routes' own answer, which
 * the API sends with `?include=can` (`can: { update, delete, restore }`,
 * conditions included: a role may be refused a record in some state). A record
 * read without it (the create's answer has none) falls back to
 * `/me.can['<Subject>.<action>']`, the permission without its conditions.
 * Returns a function, so a list's row actions can ask per row:
 *
 *   const canOf = useRecordCan('Invoice');
 *   canOf(invoice).update && <Edit />
 */
export function useRecordCan(subject: string) {
  const can = useMe()?.can;
  return useCallback(
    (record?: { can?: Partial<RecordCan> }): RecordCan => {
      const held = (action: keyof RecordCan) =>
        record?.can?.[action] ?? can?.[`${subject}.${action}`] === true;
      return {
        update: held('update'),
        delete: held('delete'),
        restore: held('restore'),
      };
    },
    [can, subject],
  );
}
