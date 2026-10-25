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
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useFlag } from '@/features/settings/use-flag';
import { useMe } from '@/lib/features';
import { freshExportFile } from '@/features/transfer/api';
import {
  disposeDataset,
  loadLocalFile,
  queryDataset,
  terminateAnalyticsEngine,
  type AnalyticsDataset,
  type DatasetFilter,
  type DatasetQuery,
  type QueryResult,
} from './engine';
import { takeAnalyticsFile } from './handoff';

const MAX_ROWS = 100;
const FLAG = 'analytics.browser.enabled';

export function AnalyticsPage(props: {
  transferId?: string;
  accountExport?: boolean;
}) {
  const { t } = useTranslation('analytics');
  const { enabled, pending } = useFlag(FLAG);
  const me = useMe();
  const identity = `${me?.user.id ?? ''}:${me?.tenant?.id ?? ''}`;
  const activeIdentity = useRef(identity);
  const [file, setFile] = useState<File>();
  const [dataset, setDataset] = useState<AnalyticsDataset>();
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState(false);
  const [column, setColumn] = useState('');
  const [operator, setOperator] =
    useState<DatasetFilter['operator']>('contains');
  const [value, setValue] = useState('');
  const [sort, setSort] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<QueryResult>();
  const [expectedColumns, setExpectedColumns] = useState<string[]>();
  const [openingExport, setOpeningExport] = useState(false);
  const current = useRef<AnalyticsDataset | undefined>(undefined);
  const loadGeneration = useRef(0);
  const staged = useRef(takeAnalyticsFile());

  const start = async (
    next?: File,
    expectedIdentity = identity,
    activeGeneration?: number,
  ) => {
    const generation = activeGeneration ?? ++loadGeneration.current;
    setOpeningExport(false);
    const previous = current.current;
    current.current = undefined;
    if (previous) {
      try {
        await disposeDataset(previous);
      } catch {
        // Cleanup can race a worker termination during navigation or tenant change.
      }
    }
    if (
      generation !== loadGeneration.current ||
      expectedIdentity !== activeIdentity.current
    )
      return;
    setDataset(undefined);
    setResult(undefined);
    setError(false);
    setFile(next);
    setColumn('');
    setSort('');
    setGroupBy('');
    setOffset(0);
    setProgress(next ? 0 : undefined);
    if (!next) return;
    try {
      const loaded = await loadLocalFile(next);
      if (generation !== loadGeneration.current) {
        await disposeDataset(loaded);
        return;
      }
      current.current = loaded;
      setDataset(loaded);
    } catch {
      if (generation === loadGeneration.current) setError(true);
    } finally {
      if (generation === loadGeneration.current) setProgress(undefined);
    }
  };

  const loadExport = async () => {
    if (!props.transferId) return;
    const generation = ++loadGeneration.current;
    const requestIdentity = identity;
    setOpeningExport(true);
    setError(false);
    try {
      const exportFile = await freshExportFile(
        props.transferId,
        props.accountExport,
      );
      if (
        generation !== loadGeneration.current ||
        requestIdentity !== activeIdentity.current
      )
        return;
      await start(exportFile, requestIdentity, generation);
    } catch {
      if (
        generation === loadGeneration.current &&
        requestIdentity === activeIdentity.current
      )
        setError(true);
    } finally {
      if (
        generation === loadGeneration.current &&
        requestIdentity === activeIdentity.current
      )
        setOpeningExport(false);
    }
  };

  useEffect(
    () => () => {
      loadGeneration.current += 1;
      terminateAnalyticsEngine();
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      loadGeneration.current += 1;
      terminateAnalyticsEngine();
      current.current = undefined;
      setDataset(undefined);
      setResult(undefined);
      setFile(undefined);
      setProgress(undefined);
    }
  }, [enabled]);

  useEffect(() => {
    if (activeIdentity.current === identity) return;
    activeIdentity.current = identity;
    loadGeneration.current += 1;
    terminateAnalyticsEngine();
    current.current = undefined;
    setDataset(undefined);
    setResult(undefined);
    setFile(undefined);
    setProgress(undefined);
  }, [identity]);

  const stagedStarted = useRef(false);
  useEffect(() => {
    if (
      !staged.current ||
      stagedStarted.current ||
      pending ||
      !enabled ||
      !me?.user.id ||
      !me?.tenant?.id
    )
      return;
    stagedStarted.current = true;
    setExpectedColumns(staged.current.expectedColumns);
    void start(staged.current.file);
  }, [identity, pending, enabled, me?.user.id, me?.tenant?.id]);

  useEffect(() => {
    if (!dataset) return;
    let alive = true;
    const request: DatasetQuery = {
      offset,
      limit: MAX_ROWS,
      ...(column && (value || operator === 'isNull' || operator === 'isNotNull')
        ? { filters: [{ column, operator, value }] }
        : {}),
      ...(sort && (!groupBy || sort === groupBy)
        ? { sort: { column: sort, direction: 'asc' as const } }
        : {}),
      ...(groupBy
        ? {
            groupBy,
            aggregate: (() => {
              const numericColumn = dataset.columns.find(
                (item) => item.name !== groupBy && isNumericColumn(item.type),
              )?.name;
              return numericColumn
                ? { column: numericColumn, fn: 'sum' as const }
                : { fn: 'count' as const };
            })(),
          }
        : {}),
    };
    void queryDataset(dataset, request)
      .then((rows) => {
        if (alive) setResult(rows);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [dataset, column, operator, value, sort, groupBy, offset]);

  useEffect(() => {
    setOffset(0);
  }, [column, operator, value, sort, groupBy]);

  if (pending) return <Skeleton className="h-40 w-full" aria-busy />;
  if (!enabled) return null;

  const columns = dataset?.columns ?? [];
  const chartData =
    result?.rows.filter(
      (row) =>
        typeof row[groupBy] === 'string' || typeof row[groupBy] === 'number',
    ) ?? [];
  const valueColumn = result?.columns.find((name) => name !== groupBy);

  return (
    <section className="flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Field>
        <FieldLabel htmlFor="analytics-file">{t('file')}</FieldLabel>
        <input
          id="analytics-file"
          type="file"
          accept=".csv,.json,.jsonl,.parquet"
          onChange={(event) => void start(event.target.files?.[0])}
          className="text-sm"
        />
      </Field>
      {props.transferId && !file && (
        <Button
          variant="outline"
          disabled={openingExport}
          onClick={() => void loadExport()}
        >
          {openingExport ? t('openingExport') : t('openExport')}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t('privacy')}</p>
      {progress !== undefined && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('loading', { percent: Math.round(progress) })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      )}
      {file && dataset && (
        <>
          <div className="rounded-md border p-4 text-sm">
            <strong>{file.name}</strong>
            <span className="ms-3">
              {t('rows', { count: dataset.rowCount })}
            </span>
            <span className="ms-3">
              {t('columns', { count: columns.length })}
            </span>
          </div>
          {expectedColumns && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('catalogMatch', {
                matched: expectedColumns.filter((name) =>
                  columns.some((item) => item.name === name),
                ).length,
                expected: expectedColumns.length,
                missing:
                  expectedColumns
                    .filter(
                      (name) => !columns.some((item) => item.name === name),
                    )
                    .join(', ') || t('noneMissing'),
              })}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect
              label={t('filterColumn')}
              value={column}
              onValueChange={setColumn}
              options={columns.map((item) => item.name)}
              empty={t('allColumns')}
            />
            <Field>
              <FieldLabel htmlFor="analytics-operator">
                {t('operator')}
              </FieldLabel>
              <select
                id="analytics-operator"
                value={operator}
                onChange={(event) =>
                  setOperator(event.target.value as typeof operator)
                }
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="contains">{t('operators.contains')}</option>
                <option value="eq">{t('operators.eq')}</option>
                <option value="neq">{t('operators.neq')}</option>
                <option value="gt">{t('operators.gt')}</option>
                <option value="gte">{t('operators.gte')}</option>
                <option value="lt">{t('operators.lt')}</option>
                <option value="lte">{t('operators.lte')}</option>
                <option value="isNull">{t('operators.isNull')}</option>
                <option value="isNotNull">{t('operators.isNotNull')}</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="analytics-value">{t('value')}</FieldLabel>
              <input
                id="analytics-value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              />
            </Field>
            <FilterSelect
              label={t('sort')}
              value={sort}
              onValueChange={setSort}
              options={groupBy ? [groupBy] : columns.map((item) => item.name)}
              empty={t('noSort')}
            />
            <FilterSelect
              label={t('groupBy')}
              value={groupBy}
              onValueChange={(next) => {
                setGroupBy(next);
                if (next && sort && sort !== next) setSort('');
              }}
              options={columns.map((item) => item.name)}
              empty={t('noGroup')}
            />
          </div>
          <div className="overflow-hidden rounded-md border">
            <Table aria-label={t('profile')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('column')}</TableHead>
                  <TableHead>{t('type')}</TableHead>
                  <TableHead>{t('nulls')}</TableHead>
                  <TableHead>{t('distinct')}</TableHead>
                  <TableHead>{t('range')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {columns.map((item) => (
                  <TableRow key={item.name}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell>{item.type}</TableCell>
                    <TableCell>{item.nullCount}</TableCell>
                    <TableCell>{item.distinctCount ?? '—'}</TableCell>
                    <TableCell>
                      {item.min == null && item.max == null
                        ? '—'
                        : `${String(item.min ?? '—')} – ${String(item.max ?? '—')}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {groupBy && valueColumn && chartData.length > 0 && (
            <div
              className="h-64 w-full rounded-md border p-3"
              aria-label={t('chart')}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={groupBy} />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey={valueColumn} fill="var(--chart-1)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="overflow-auto rounded-md border">
            <Table aria-label={t('results')}>
              <TableHeader>
                <TableRow>
                  {(result?.columns ?? []).map((name) => (
                    <TableHead key={name}>{name}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(result?.rows ?? []).map((row, index) => (
                  <TableRow key={index}>
                    {(result?.columns ?? []).map((name) => (
                      <TableCell key={name}>{display(row[name])}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('shown', {
              shown: result?.rows.length ?? 0,
              total: result?.totalRows ?? 0,
              max: MAX_ROWS,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - MAX_ROWS))}
            >
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              disabled={offset + MAX_ROWS >= (result?.totalRows ?? 0)}
              onClick={() => setOffset(offset + MAX_ROWS)}
            >
              {t('next')}
            </Button>
          </div>
          <Button variant="outline" onClick={() => void start()}>
            {t('closeFile')}
          </Button>
        </>
      )}
    </section>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  empty: string;
}) {
  return (
    <Field>
      <FieldLabel>{props.label}</FieldLabel>
      <Select
        value={props.value || '__none'}
        onValueChange={(value) =>
          props.onValueChange(value === '__none' ? '' : (value ?? ''))
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{props.empty}</SelectItem>
          {props.options.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function display(value: unknown) {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object'
    ? JSON.stringify(value, (_, child: unknown) => {
        if (typeof child === 'bigint') return child.toString();
        if (child instanceof Map) return Array.from(child);
        return child;
      })
    : String(value);
}

function isNumericColumn(type: string) {
  return /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL)(?:\b|\()/i.test(
    type.trim(),
  );
}
