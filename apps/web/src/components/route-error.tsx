import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The router's `defaultErrorComponent` (TanStack Router: a route that throws
 * while loading or rendering shows this in its own place; the layouts above
 * it, the sidebar included, stay). The report id is what a user quotes to
 * support; the error is logged with it. Custom code, because the router only
 * offers the hook, not the page; the tracking adapter of #404 plugs in at
 * `reportRouteError` when it lands.
 */
export function reportRouteError(error: unknown, reportId: string) {
  console.error(`[${reportId}] route error`, error);
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const reportId = useMemo(
    () => crypto.randomUUID().slice(0, 8),
    // A new error is a new report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [error],
  );
  useEffect(() => reportRouteError(error, reportId), [error, reportId]);

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
