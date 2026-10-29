import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useDateTimeFormat } from '@/lib/date-time';
import { useRealtimeEvent } from '@/lib/realtime';
import { normalizeRedirect } from '@/lib/safe-redirect';
import { useDismissWork, workQuery, type WorkItem } from './api';

/** `/work`: what waits on the person, from every source, a page at a time. */
export function WorkPage() {
  const { t } = useTranslation('work');
  const router = useRouter();
  const queryClient = useQueryClient();
  const date = useDateTimeFormat();
  const list = useInfiniteQuery(workQuery);
  const dismiss = useDismissWork();
  // A new notification may be a mention; a decision elsewhere settles an approval.
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: workQuery.queryKey });
  useRealtimeEvent('notification', refresh);
  useRealtimeEvent('approval.assigned', refresh);
  useRealtimeEvent('approval.decided', refresh);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  const open = (item: WorkItem) => {
    const path = normalizeRedirect(item.link);
    if (path) {
      router.history.push(path);
    }
  };

  return (
    <Page>
      <PageHeader title={t('page.title')} description={t('page.description')} />
      {list.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={t('page.empty')} />
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 p-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col text-left"
                onClick={() => open(item)}
              >
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{t(`kind.${item.kind}`)}</Badge>
                  <span className="truncate text-sm font-medium">
                    {String(item.data.title ?? '')}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">
                  {item.kind === 'mention'
                    ? t('item.mention', { by: String(item.data.by ?? '') })
                    : t('item.approval', {
                        requester: String(item.data.requester ?? ''),
                      })}
                  {item.dueAt &&
                    ` · ${t('item.due', { date: date(item.dueAt) })}`}
                </span>
              </button>
              {item.canDismiss && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(item.key)}
                >
                  {t('item.dismiss')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('page.more')}
        </Button>
      )}
    </Page>
  );
}
