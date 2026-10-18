import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
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
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/lib/features';
import {
  catalogQuery,
  remember,
  startExport,
  type TransferFormat,
} from './api';
import { TransferStatus } from './transfer-status';

/**
 * Export from a list page: the format, the list's current filter and search
 * (`filters`, from `exportFilters(params)`), then the job's progress and the
 * download. Shown only when the caller may export `exporter` (`GET /v1/data`).
 */
export function ExportButton(props: {
  exporter: string;
  filters: Record<string, string>;
}) {
  const { t } = useTranslation('transfer');
  const me = useMe();
  const catalog = useQuery({ ...catalogQuery, meta: { errorToast: false } });
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<TransferFormat>('csv');
  const [jobId, setJobId] = useState<string>();
  const start = useMutation({
    mutationFn: () =>
      startExport({
        name: props.exporter,
        format,
        filters: props.filters,
      }),
    onSuccess: (started) => {
      setJobId(started.id);
      if (me) {
        remember(me.user.id, {
          id: started.id,
          kind: 'export',
          name: props.exporter,
          at: new Date().toISOString(),
        });
      }
    },
  });

  const exporter = catalog.data?.exports.find((e) => e.name === props.exporter);
  if (!exporter) return null;
  const filtered = Object.keys(props.filters).length > 0;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <DownloadIcon />
        {t('export.action')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setJobId(undefined);
            start.reset();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('export.title')}</DialogTitle>
            <DialogDescription>
              {filtered ? t('export.filtered') : t('export.unfiltered')}
            </DialogDescription>
          </DialogHeader>
          {jobId ? (
            <>
              <TransferStatus id={jobId} />
              <p className="text-xs text-muted-foreground">
                <Link to="/transfers" className="underline">
                  {t('export.mine')}
                </Link>
              </p>
            </>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="export-format">
                  {t('export.format')}
                </FieldLabel>
                <Select
                  items={exporter.formats.map((f) => ({
                    value: f,
                    label: t(`formats.${f}`),
                  }))}
                  value={format}
                  onValueChange={(value) =>
                    setFormat((value ?? 'csv') as TransferFormat)
                  }
                >
                  <SelectTrigger id="export-format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {exporter.formats.map((f) => (
                      <SelectItem key={f} value={f}>
                        {t(`formats.${f}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <DialogFooter>
                <Button
                  disabled={start.isPending}
                  onClick={() => start.mutate()}
                >
                  {start.isPending && <Spinner />}
                  {t('export.start')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
