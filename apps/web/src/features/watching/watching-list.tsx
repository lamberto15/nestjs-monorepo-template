import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EyeOffIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDateTimeFormat } from '@/lib/date-time';
import {
  subscriptionsQuery,
  useStopWatching,
  useStoppingRows,
  type Subscription,
} from './api';
import { recordLinkOf } from './record-links';

/** `/account/watching`: the records the user watches, with a way to stop. */
export function WatchingList() {
  const { t } = useTranslation('watching');
  const list = useInfiniteQuery(subscriptionsQuery);
  const stop = useStopWatching();
  const stopping = useStoppingRows();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  if (list.isPending) {
    return <Spinner />;
  }
  if (list.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">{t('error')}</p>
        <Button variant="outline" onClick={() => void list.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul className="rounded-lg border">
          {items.map((item) => (
            <WatchingRow
              key={`${item.subject}/${item.recordId}`}
              item={item}
              stopping={stopping.has(`${item.subject}/${item.recordId}`)}
              onStop={() => stop.mutate(item)}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage && <Spinner />}
          {t('loadMore')}
        </Button>
      )}
    </div>
  );
}

function WatchingRow(props: {
  item: Subscription;
  stopping: boolean;
  onStop: () => void;
}) {
  const { t } = useTranslation('watching');
  const date = useDateTimeFormat();
  const { subject, recordId, createdAt } = props.item;
  const link = recordLinkOf(subject);
  // The name is a nicety: a record that can't be read (gone, no longer
  // visible) keeps its id, and no toast for it.
  const title = useQuery({
    queryKey: ['watching', 'title', subject, recordId],
    queryFn: () => link!.title(recordId),
    enabled: !!link,
    retry: false,
    // One read per row: not again at every focus.
    staleTime: 60_000,
    meta: { errorToast: false },
  });
  const label = title.data ?? recordId;
  const name = t(`subjects.${subject}`, { defaultValue: subject });

  return (
    <li className="flex flex-wrap items-center gap-3 border-b p-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        {link ? (
          <Link
            to={link.path(recordId)}
            className="font-medium break-words hover:underline"
          >
            {label}
          </Link>
        ) : (
          <span className="font-mono text-sm break-all">{label}</span>
        )}
        <p className="text-sm text-muted-foreground">
          {name} · {t('since', { date: date(createdAt) })}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={props.stopping}
        aria-label={t('stopNamed', { name: label })}
        onClick={props.onStop}
      >
        {props.stopping ? <Spinner /> : <EyeOffIcon />}
        {t('stop')}
      </Button>
    </li>
  );
}
