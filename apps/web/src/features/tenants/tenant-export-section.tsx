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
import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/account/section';
import { TransferStatus } from '@/features/transfer/transfer-status';
import {
  TENANT_EXPORT_FORMATS,
  useExportTenant,
  type TenantExportFormat,
  type TenantRow,
} from './queries';

/**
 * Every record of the tenant as a file (docs/tenancy.md, "Exporting a
 * tenant"): a data transfer queued in a worker, whose progress and signed
 * download link (30 minutes) `TransferStatus` follows. The sign-in must be
 * a recent one: lib/api.ts asks again and retries. Each start is a new
 * transfer, so the page shows the latest one.
 */
export function ExportSection(props: { tenant: TenantRow }) {
  const { t } = useTranslation('tenants');
  const { t: tTransfer } = useTranslation('transfer');
  const [format, setFormat] = useState<TenantExportFormat>('json');
  const [jobId, setJobId] = useState<string>();
  const start = useExportTenant(props.tenant.id);
  return (
    <Section
      title={t('detail.export.title')}
      description={t('detail.export.description')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-48">
          <FieldLabel htmlFor="tenant-export-format">
            {tTransfer('export.format')}
          </FieldLabel>
          <Select
            items={TENANT_EXPORT_FORMATS.map((f) => ({
              value: f,
              label: tTransfer(`formats.${f}`),
            }))}
            value={format}
            onValueChange={(value) =>
              setFormat((value ?? 'json') as TenantExportFormat)
            }
          >
            <SelectTrigger id="tenant-export-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TENANT_EXPORT_FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {tTransfer(`formats.${f}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={start.isPending}
          onClick={() =>
            start.mutate(format, {
              onSuccess: (started) => setJobId(started.id),
            })
          }
        >
          {start.isPending ? <Spinner /> : <DownloadIcon />}
          {t('detail.export.start')}
        </Button>
      </div>
      {jobId && (
        // Keyed by the transfer: a new export starts a fresh follow-up.
        <TransferStatus key={jobId} id={jobId} />
      )}
    </Section>
  );
}
