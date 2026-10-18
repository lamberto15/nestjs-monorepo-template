import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateTimeFormat } from '@/lib/date-time';
import { useMe } from '@/lib/features';
import { forget, readHistory, transferQuery, type Started } from './api';
import { TransferStatus } from './transfer-status';

/**
 * Past exports and imports of this browser. The API has no list of
 * transfers (only one by id), so the ids come from what this browser
 * started (`readHistory`); one the API no longer knows (another tenant,
 * cleaned up) is dropped.
 */
export function TransfersPage() {
  const { t } = useTranslation('transfer');
  const me = useMe();
  const userId = me?.user.id ?? '';
  const [items] = useState<Started[]>(() => readHistory(userId));
  const date = useDateTimeFormat();

  const results = useQueries({
    queries: items.map((item) => ({
      ...transferQuery(item.id),
      meta: { errorToast: false },
      retry: false,
    })),
  });
  // One the API no longer knows (404) is hidden now and forgotten for next time.
  const gone = items
    .filter((_item, index) => {
      const error = results[index]?.error;
      return isApiError(error) && error.status === 404;
    })
    .map((item) => item.id);
  const goneKey = gone.join(',');
  useEffect(() => {
    for (const id of goneKey ? goneKey.split(',') : []) forget(userId, id);
  }, [goneKey, userId]);
  const shown = items.filter((item) => !gone.includes(item.id));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">{t('mine.title')}</h1>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/transfers/import" />}
        >
          {t('mine.import')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('mine.description')}</p>
      {shown.length === 0 ? (
        <p
          role="status"
          className="rounded-md border p-8 text-center text-sm text-muted-foreground"
        >
          {t('mine.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('mine.title')}>
          {shown.map((item) => (
            <li key={item.id} className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{t(`kind.${item.kind}`)}</Badge>
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground">{date(item.at)}</span>
              </div>
              <TransferStatus id={item.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
