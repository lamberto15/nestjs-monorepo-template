import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * What every feature's record pages share (the pattern docs/monorepo.md,
 * "Record pages", describes): the query keys, so a write invalidates the lists
 * and the record it changed, and the two problems pages branch on.
 *
 * `path` is the feature's list route (`/v1/notes`), as in ListPage.
 */
export const recordKeys = {
  /** Every page of the feature's list (ListPage's key is `['list', path, params]`). */
  lists: (path: string) => ['list', path] as const,
  /** One record, with its ETag. */
  detail: (path: string, id: string) => ['record', path, id] as const,
  /** Every record of the feature. */
  details: (path: string) => ['record', path] as const,
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
