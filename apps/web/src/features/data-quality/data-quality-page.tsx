import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import {
  dataQualityQuery,
  type DataQualityFinding,
  type DataQualityScan,
  findingsQuery,
  useDismissFinding,
  useRecheckFinding,
  useStartScan,
} from './api';

/**
 * The data-quality dashboard (docs/data-quality.md): the open findings per
 * kind of record, how fresh they are, and each finding to dismiss or check
 * again. Nothing here changes a record: people fix them where they live.
 */
export function DataQualityPage() {
  const { t } = useTranslation('data-quality');
  const summary = useQuery({
    ...dataQualityQuery,
    meta: { errorToast: false },
  });
  const [subject, setSubject] = useState<string>();
  const shown = subject ?? summary.data?.subjects[0]?.subject;

  return (
    <Page>
      <PageHeader title={t('title')} description={t('description')} />
      {summary.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {summary.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(summary.error)}
        </p>
      )}
      {summary.isSuccess && (
        <>
          <ScanCard scan={summary.data.lastScan} />
          {summary.data.subjects.length === 0 ? (
            <EmptyState title={t('none')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('subject')}</TableHead>
                  <TableHead>{t('errors')}</TableHead>
                  <TableHead>{t('suggestions')}</TableHead>
                  <TableHead>{t('dismissed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.data.subjects.map((row) => (
                  <TableRow
                    key={row.subject}
                    data-state={row.subject === shown ? 'selected' : undefined}
                  >
                    <TableCell>
                      <Button
                        variant="link"
                        className="px-0"
                        aria-pressed={row.subject === shown}
                        onClick={() => setSubject(row.subject)}
                      >
                        {row.subject}
                      </Button>
                    </TableCell>
                    <TableCell>{row.errors}</TableCell>
                    <TableCell>{row.suggestions}</TableCell>
                    <TableCell>{row.dismissed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {shown && <Findings key={shown} subject={shown} />}
        </>
      )}
    </Page>
  );
}

/** The last scan: when, how far, and a button to scan again. */
function ScanCard({ scan }: { scan: DataQualityScan | null }) {
  const { t } = useTranslation('data-quality');
  const canManage = useCan('DataQuality.manage');
  const start = useStartScan();
  const running = scan?.status === 'queued' || scan?.status === 'running';

  async function onScan() {
    try {
      await start.mutateAsync();
      toast.success(t('scanStarted'));
    } catch {
      // The mutation's toast says why (a scan already running is a 409).
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('freshness')}</CardTitle>
        <CardDescription>
          {!scan
            ? t('neverScanned')
            : running
              ? t('scanning', { scanned: scan.scanned, total: scan.total })
              : scan.status === 'failed'
                ? t('scanFailed', { at: formatDateTime(scan.createdAt) })
                : t('lastScan', {
                    at: formatDateTime(scan.finishedAt ?? scan.createdAt),
                    n: scan.findings ?? 0,
                  })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {running && (
          <Progress
            value={scan.total ? (scan.scanned / scan.total) * 100 : null}
            aria-label={t('progress')}
          />
        )}
        {canManage && (
          <div>
            <Button onClick={onScan} disabled={running || start.isPending}>
              {t('scan')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One subject's findings, open or dismissed. */
function Findings({ subject }: { subject: string }) {
  const { t } = useTranslation('data-quality');
  const [dismissed, setDismissed] = useState(false);
  const findings = useQuery(findingsQuery(subject, dismissed));
  const switchId = `data-quality-${subject}-dismissed`;

  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t('findingsOf', { subject })}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-base font-medium">
          {t('findingsOf', { subject })}
        </h2>
        <Switch
          id={switchId}
          checked={dismissed}
          onCheckedChange={setDismissed}
        />
        <label htmlFor={switchId} className="text-sm">
          {t('showDismissed')}
        </label>
      </div>
      {findings.isPending && <Skeleton className="h-24 w-full" aria-busy />}
      {findings.isSuccess &&
        (findings.data.items.length === 0 ? (
          <EmptyState title={dismissed ? t('noneDismissed') : t('noneOpen')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('severity')}</TableHead>
                <TableHead>{t('problem')}</TableHead>
                <TableHead>{t('record')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {findings.data.items.map((finding) => (
                <FindingRow key={finding.id} finding={finding} />
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}

function FindingRow({ finding }: { finding: DataQualityFinding }) {
  const { t } = useTranslation('data-quality');
  const canManage = useCan('DataQuality.manage');
  const dismiss = useDismissFinding();
  const recheck = useRecheckFinding();
  const problem = t(`check.${finding.check}`, {
    field: finding.field,
    other: finding.detail?.duplicateOf ?? finding.detail?.referencedId ?? '',
  });

  async function onRecheck() {
    const result = await recheck.mutateAsync(finding.id);
    toast.success(result.resolved ? t('resolved') : t('stillThere'));
  }

  async function onDismiss() {
    await dismiss.mutateAsync(finding.id);
    toast.success(t('dismissedToast'));
  }

  return (
    <TableRow>
      <TableCell>
        <Badge
          variant={finding.severity === 'error' ? 'destructive' : 'secondary'}
        >
          {t(`severityLabel.${finding.severity}`)}
        </Badge>
      </TableCell>
      <TableCell>{problem}</TableCell>
      <TableCell className="font-mono text-xs">{finding.recordId}</TableCell>
      <TableCell className="text-end">
        {canManage && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={recheck.isPending}
              onClick={() => void onRecheck()}
              aria-label={t('recheckLabel', { problem })}
            >
              {t('recheck')}
            </Button>
            {!finding.dismissedAt && (
              <Button
                size="sm"
                variant="ghost"
                disabled={dismiss.isPending}
                onClick={() => void onDismiss()}
                aria-label={t('dismissLabel', { problem })}
              >
                {t('dismiss')}
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
