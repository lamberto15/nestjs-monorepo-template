import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AnalyticsDataset,
  DatasetChecks,
} from '@/features/analytics/engine';
import {
  compareImport,
  hasFindings,
  planChecks,
  type CatalogColumn,
} from './import-profile';

/** The formats the local engine reads that the import page accepts (xlsx is not one). */
export const LOCALLY_CHECKABLE = /\.(csv|json)$/i;

type Engine = typeof import('@/features/analytics/engine');
type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; dataset: AnalyticsDataset }
  | { kind: 'error' }
  | { kind: 'cancelled' };

/**
 * A local, informational check of the chosen import file against the catalog
 * (docs/analytics.md): DuckDB-Wasm reads the file in this browser, so nothing is
 * uploaded. The engine is imported only when this component mounts, which the
 * page does only with `analytics.browser.enabled` on and a file chosen. The
 * server's `dryRun` stays authoritative.
 *
 * Lifecycle: choosing another file disposes the previous dataset (the engine
 * then starts a fresh session); leaving the page, turning the flag off or
 * changing the signed-in identity (the parent remounts this by `key`) ends the
 * engine; Cancel ends it too.
 */
export function LocalCheck(props: {
  file: File;
  columns: CatalogColumn[];
  matchOn: string;
}) {
  const { file, columns, matchOn } = props;
  const { t, i18n } = useTranslation('transfer');
  const supported = LOCALLY_CHECKABLE.test(file.name);
  const engine = useRef<Engine>(undefined);
  const run = useRef({ live: false });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [checks, setChecks] = useState<{
    key: string;
    value?: DatasetChecks;
  }>();

  useEffect(
    () => () => {
      run.current.live = false;
      engine.current?.terminateAnalyticsEngine();
    },
    [],
  );

  useEffect(() => {
    if (!supported) return;
    const current = { live: true };
    run.current = current;
    let loaded: AnalyticsDataset | undefined;
    setPhase({ kind: 'loading' });
    setChecks(undefined);
    void (async () => {
      try {
        const loadedEngine = await import('@/features/analytics/engine');
        engine.current = loadedEngine;
        if (!current.live) return;
        const dataset = await loadedEngine.loadLocalFile(file);
        if (!current.live) {
          void loadedEngine.disposeDataset(dataset).catch(() => undefined);
          return;
        }
        loaded = dataset;
        setPhase({ kind: 'ready', dataset });
      } catch {
        // Informational: a file the engine cannot read is still importable.
        if (current.live) setPhase({ kind: 'error' });
      }
    })();
    return () => {
      current.live = false;
      if (loaded)
        void engine.current?.disposeDataset(loaded).catch(() => undefined);
    };
  }, [file, supported, attempt]);

  const dataset = phase.kind === 'ready' ? phase.dataset : undefined;
  const request = useMemo(
    () =>
      dataset &&
      planChecks({
        catalog: columns,
        columns: dataset.columns,
        rowCount: dataset.rowCount,
        matchOn,
      }),
    [dataset, columns, matchOn],
  );
  const requestKey = JSON.stringify(request ?? null);
  const checking = !!request && checks?.key !== requestKey && !!dataset;
  useEffect(() => {
    if (!dataset || !request || !engine.current) return;
    if (!request.duplicateKey && !request.parse) {
      setChecks({ key: requestKey, value: { unparseable: {} } });
      return;
    }
    const current = run.current;
    let live = true;
    engine.current
      .checkDataset(dataset, request)
      .then((value) => {
        if (live && current.live) setChecks({ key: requestKey, value });
      })
      .catch(() => {
        if (live && current.live) setChecks({ key: requestKey });
      });
    return () => {
      live = false;
    };
    // `request` is derived from `requestKey`; the key is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, requestKey]);

  const cancel = () => {
    run.current.live = false;
    engine.current?.terminateAnalyticsEngine();
    setPhase({ kind: 'cancelled' });
  };

  const findings = useMemo(
    () =>
      dataset && checks?.key === requestKey
        ? compareImport({
            catalog: columns,
            columns: dataset.columns,
            rowCount: dataset.rowCount,
            matchOn,
            checks: checks.value,
          })
        : undefined,
    [dataset, columns, matchOn, checks, requestKey],
  );
  const percent = (share: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: 'percent',
      maximumFractionDigits: 0,
    }).format(share);

  let body: ReactNode;
  if (!supported) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t('import.local.unsupported')}
      </p>
    );
  } else if (phase.kind === 'error' || phase.kind === 'cancelled') {
    body = (
      <Alert variant={phase.kind === 'error' ? 'destructive' : 'default'}>
        <AlertDescription>
          {phase.kind === 'error'
            ? t('import.local.error')
            : t('import.local.cancelled')}
          <Button
            variant="outline"
            size="sm"
            type="button"
            className="ms-2"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('import.local.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (!dataset || checking || !findings) {
    body = (
      <div role="status" className="flex items-center gap-2 text-sm">
        <Spinner />
        <span>{t('import.local.loading')}</span>
        <Button variant="outline" size="sm" type="button" onClick={cancel}>
          {t('import.local.cancel')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {t('import.local.summary', {
            rows: dataset.rowCount,
            columns: dataset.columns.length,
          })}{' '}
          {hasFindings(findings) ? '' : t('import.local.clean')}
        </p>
        {checks?.value === undefined && (
          <p className="text-xs text-muted-foreground">
            {t('import.local.checksFailed')}
          </p>
        )}
        {findings.missingRequired.length > 0 && (
          <Group
            title={t('import.local.missing')}
            count={findings.missingRequired.length}
          >
            {findings.missingRequired.join(', ')}
          </Group>
        )}
        {findings.matchKeyMissing !== undefined && (
          <Group title={t('import.local.matchKeyMissing')} count={1}>
            {findings.matchKeyMissing}
          </Group>
        )}
        {findings.unknown.length > 0 && (
          <Group
            title={t('import.local.unknown')}
            count={findings.unknown.length}
          >
            {findings.unknown.join(', ')}
          </Group>
        )}
        {findings.types.length > 0 && (
          <Group title={t('import.local.types')} count={findings.types.length}>
            <FindingTable
              label={t('import.local.types')}
              heads={[
                t('import.column'),
                t('import.local.expected'),
                t('import.local.found'),
              ]}
              rows={findings.types.map((item) => [
                item.column,
                item.expected,
                item.badValues
                  ? t('import.local.badValues', {
                      amount: item.badValues,
                      type: item.expected,
                    })
                  : item.detected,
              ])}
            />
          </Group>
        )}
        {findings.duplicates && (
          <Group
            title={t('import.local.duplicates', {
              key: findings.duplicates.column,
            })}
            count={findings.duplicates.extraRows}
          >
            {t('import.local.duplicatesDetail', {
              amount: findings.duplicates.extraRows,
              samples: findings.duplicates.samples.join(', '),
            })}
          </Group>
        )}
        {findings.nullHeavy.length > 0 && (
          <Group
            title={t('import.local.nulls')}
            count={findings.nullHeavy.length}
          >
            <FindingTable
              label={t('import.local.nulls')}
              heads={[t('import.column'), t('import.local.empty')]}
              rows={findings.nullHeavy.map((item) => [
                item.column,
                t('import.local.emptyShare', {
                  percent: percent(item.share),
                  amount: item.nullCount,
                  rows: dataset.rowCount,
                }),
              ])}
            />
          </Group>
        )}
      </div>
    );
  }

  return (
    <Card size="sm" aria-label={t('import.local.title')}>
      <CardHeader>
        <CardTitle>{t('import.local.title')}</CardTitle>
        <CardDescription>{t('import.local.description')}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function Group(props: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {props.title}
        <Badge variant="secondary">{props.count}</Badge>
      </h3>
      <div className="text-sm text-muted-foreground">{props.children}</div>
    </section>
  );
}

function FindingTable(props: {
  label: string;
  heads: string[];
  rows: string[][];
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <Table aria-label={props.label}>
        <TableHeader>
          <TableRow>
            {props.heads.map((head) => (
              <TableHead key={head}>{head}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((row) => (
            <TableRow key={row[0]}>
              {row.map((cell, index) => (
                <TableCell
                  key={index}
                  className={index === 0 ? 'font-medium' : ''}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
