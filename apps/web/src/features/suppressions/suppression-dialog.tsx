import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { suppressionQuery } from './queries';

/**
 * One entry as the API has it (`GET /v1/mail/suppressions/{id}`): what the
 * table has no room for. The provider's last word, the note and the author
 * are text from outside: rendered as text, never as markup.
 */
export function SuppressionDialog(props: {
  id: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('suppressions');
  const format = useDateTimeFormat();
  const one = useQuery({
    ...suppressionQuery(props.id ?? ''),
    enabled: props.id !== undefined,
    meta: { errorToast: false },
  });
  const entry = one.data;
  const rows: [string, ReactNode][] = entry
    ? [
        [t('detail.reason'), t(`reason.${entry.reason}`)],
        [t('detail.source'), entry.source],
        [t('detail.note'), entry.note ?? ''],
        [t('detail.lastDetail'), entry.lastDetail ?? ''],
        [t('detail.events'), entry.events],
        [t('detail.softBounces'), entry.softBounces],
        [t('detail.firstSeen'), format(entry.firstSeenAt)],
        [t('detail.lastSeen'), format(entry.lastSeenAt)],
        [
          t('detail.suppressedAt'),
          entry.suppressedAt
            ? format(entry.suppressedAt)
            : t('status.watching'),
        ],
        [t('detail.skipped'), entry.skipped],
        [t('detail.lastSkipped'), format(entry.lastSkippedAt)],
        [t('detail.createdBy'), entry.createdBy ?? ''],
      ]
    : [];
  return (
    <Dialog
      open={props.id !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-base">
            {entry?.address ?? t('detail.title')}
          </DialogTitle>
          <DialogDescription>{t('detail.description')}</DialogDescription>
        </DialogHeader>
        {one.isPending ? (
          <Spinner />
        ) : one.isError ? (
          <FormAlert message={errorMessage(one.error)} />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
