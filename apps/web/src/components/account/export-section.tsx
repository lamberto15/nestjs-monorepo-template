import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/account/section';
import {
  ACCOUNT_EXPORTS_KEY,
  startAccountExport,
} from '@/components/account/privacy-api';
import {
  readHistory,
  remember,
  type Started,
} from '@/components/account/export-history';
import type { TransferFormat } from '@/features/transfer/api';
import { TransferStatus } from '@/features/transfer/transfer-status';
import { useDateTimeFormat } from '@/lib/date-time';

const FORMATS: TransferFormat[] = ['json', 'csv', 'xlsx'];
/** The exports shown: the API keeps a finished one 7 days. */
const SHOWN = 5;

/**
 * A copy of everything held about you (`POST /v1/account/export`): the job
 * runs in the background, its progress is polled, then its file downloads
 * (`GET /v1/data/transfers/{id}`, a link valid 30 minutes, made anew at
 * each read). `GET /v1/data/transfers` never lists an account export, so
 * the ids this browser started are remembered here (as /transfers does).
 */
export function ExportSection(props: { userId: string }) {
  const { t } = useTranslation('privacy');
  const { t: tt } = useTranslation('transfer');
  const format = useDateTimeFormat();
  const [kind, setKind] = useState<TransferFormat>('json');
  const [history, setHistory] = useState<Started[]>(() =>
    readHistory(props.userId, ACCOUNT_EXPORTS_KEY),
  );
  const start = useMutation({
    mutationFn: () => startAccountExport(kind),
    onSuccess: (started) => {
      remember(
        props.userId,
        {
          id: started.id,
          kind: 'export',
          name: 'account',
          at: new Date().toISOString(),
        },
        ACCOUNT_EXPORTS_KEY,
      );
      setHistory(readHistory(props.userId, ACCOUNT_EXPORTS_KEY));
    },
  });
  return (
    <Section title={t('export.title')} description={t('export.description')}>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-48">
          <FieldLabel htmlFor="account-export-format">
            {tt('export.format')}
          </FieldLabel>
          <Select
            items={FORMATS.map((f) => ({
              value: f,
              label: tt(`formats.${f}`),
            }))}
            value={kind}
            onValueChange={(value) =>
              setKind((value ?? 'json') as TransferFormat)
            }
          >
            <SelectTrigger id="account-export-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {tt(`formats.${f}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? <Spinner /> : <DownloadIcon />}
          {t('export.start')}
        </Button>
      </div>
      {history.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {history.slice(0, SHOWN).map((item) => (
            <li key={item.id} className="flex flex-col gap-2 p-3">
              <span className="text-xs text-muted-foreground">
                {t('export.startedAt', { date: format(item.at) })}
              </span>
              <TransferStatus id={item.id} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('export.kept')}</p>
    </Section>
  );
}
