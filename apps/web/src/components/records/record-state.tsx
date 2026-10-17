import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { isNotFound } from '@/lib/records';

/**
 * A record page's loading, not-found and error states around its content:
 * `children` gets the data once it is there. Texts are the caller's (the
 * feature's namespace).
 */
export function RecordState<T>(props: {
  query: UseQueryResult<T>;
  notFound: { title: string; description: string };
  error: { title: string; generic: string; retry: string };
  children: (data: T) => ReactNode;
}) {
  const { query } = props;
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-32 w-full max-w-2xl" />
      </div>
    );
  }
  if (query.isError) {
    if (isNotFound(query.error)) {
      return (
        <div role="status" className="flex flex-col gap-1 py-8">
          <h1 className="text-xl font-medium">{props.notFound.title}</h1>
          <p className="text-sm text-muted-foreground">
            {props.notFound.description}
          </p>
        </div>
      );
    }
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-md border border-destructive/40 p-4 text-sm"
      >
        <div>
          <p className="font-medium">{props.error.title}</p>
          <p className="text-muted-foreground">
            {isApiError(query.error) ? query.error.detail : props.error.generic}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
        >
          {props.error.retry}
        </Button>
      </div>
    );
  }
  return props.children(query.data);
}
