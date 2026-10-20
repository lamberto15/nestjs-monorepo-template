import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { holdQuery } from './api';
import { ReleaseHoldDialog } from './release-dialog';

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="text-sm break-words whitespace-pre-wrap">
        {props.children}
      </dd>
    </div>
  );
}

/** One hold in full (`GET /v1/legal-holds/{id}`), with Release while active. */
export function HoldDialog(props: {
  id: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('legal-holds');
  const format = useDateTimeFormat();
  const [releasing, setReleasing] = useState(false);
  const query = useQuery({
    ...holdQuery(props.id),
    meta: { errorToast: false },
  });
  const hold = query.data;
  return (
    <>
      <Dialog open onOpenChange={props.onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('detail.title')}</DialogTitle>
            <DialogDescription>{t('detail.description')}</DialogDescription>
          </DialogHeader>
          {query.isPending && <Skeleton className="h-32 w-full" aria-busy />}
          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(query.error)}
            </p>
          )}
          {hold && (
            <dl className="flex flex-col gap-3">
              <Row label={t('detail.status')}>
                <Badge variant={hold.active ? 'destructive' : 'outline'}>
                  {t(hold.active ? 'status.active' : 'status.released')}
                </Badge>
              </Row>
              <Row label={t('detail.subject')}>{hold.subject}</Row>
              <Row label={t('detail.record')}>
                {hold.recordId ?? t('allRecords')}
              </Row>
              <Row label={t('detail.reason')}>{hold.reason}</Row>
              <Row label={t('detail.placed')}>
                {t('detail.by', {
                  at: format(hold.placedAt),
                  by: hold.placedBy,
                })}
              </Row>
              {!hold.active && (
                <>
                  <Row label={t('detail.releasedAt')}>
                    {t('detail.by', {
                      at: format(hold.releasedAt),
                      by: hold.releasedBy,
                    })}
                  </Row>
                  {hold.releaseNote && (
                    <Row label={t('detail.releaseNote')}>
                      {hold.releaseNote}
                    </Row>
                  )}
                </>
              )}
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => props.onOpenChange(false)}>
              {t('detail.close')}
            </Button>
            {hold?.active && (
              <Button variant="destructive" onClick={() => setReleasing(true)}>
                {t('release.button')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {hold && releasing && (
        <ReleaseHoldDialog
          hold={hold}
          onOpenChange={setReleasing}
          onReleased={() => {
            setReleasing(false);
            props.onOpenChange(false);
          }}
        />
      )}
    </>
  );
}
