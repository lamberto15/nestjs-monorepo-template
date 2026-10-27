import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { loadedSha } from '@/lib/build-version';
import { reportClientError, reportIdOf } from '@/lib/report-error';

/**
 * The router's `defaultErrorComponent` (TanStack Router: a route that throws
 * while loading or rendering shows this in its own place; the layouts above
 * it, the sidebar included, stay). What a user quotes to support: the report
 * id (lib/report-error.ts, the same as React's own report of the error),
 * the API's request id when the route's request failed, and the build.
 * Custom code, because the router only offers the hook, not the page.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  // A new error is a new report.
  const reportId = useMemo(() => reportIdOf(error), [error]);
  useEffect(() => void reportClientError(error, 'route'), [error]);
  const requestId = isApiError(error) ? error.requestId : undefined;

  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <h1 className="text-xl font-medium">{t('routeError.title')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('routeError.description')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('routeError.reportId', { id: reportId })}
        {requestId && <> · {t('errors.requestId', { id: requestId })}</>}
        {loadedSha && (
          <> · {t('routeError.build', { sha: loadedSha.slice(0, 12) })}</>
        )}
      </p>
      <Button
        variant="outline"
        onClick={() => {
          // The documented retry: load the route's data again, then render it.
          void router.invalidate();
          reset();
        }}
      >
        {t('routeError.retry')}
      </Button>
    </div>
  );
}
