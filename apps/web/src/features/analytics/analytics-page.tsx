import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadList,
  FileUploadTrigger,
} from '@nestjs-monorepo-template/ui/components/file-upload';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { UploadIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';
import { useFlag } from '@/features/settings/use-flag';
import { useMe } from '@/lib/features';
import { freshExportFile } from '@/features/transfer/api';
import { isNumericColumn, isTemporalColumn } from './column-types';
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
import { OptionSelect } from './option-select';
import { display } from './display';
import { ResultChart } from './result-chart';

const MAX_ROWS = 100;
const HISTOGRAM_BINS = 20;
/** How long the value filter waits for the next keystroke before it queries. */
const FILTER_DEBOUNCE_MS = 300;
const FLAG = 'analytics.browser.enabled';

type Mode = 'rows' | 'group' | 'histogram' | 'series';
type Aggregate = NonNullable<DatasetQuery['aggregate']>['fn'];
type Operator = DatasetFilter['operator'];
type Unit = 'day' | 'week' | 'month';

const OPERATORS: Operator[] = [
  'contains',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
];
const AGGREGATES: Aggregate[] = ['count', 'sum', 'avg', 'min', 'max'];
const UNITS: Unit[] = ['day', 'week', 'month'];

const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

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
  const [loading, setLoading] = useState(false);
  // The last query that finished (or failed): a request that differs is running.
  const [settled, setSettled] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<Mode>('rows');
  const [column, setColumn] = useState('');
  const [operator, setOperator] = useState<Operator>('contains');
  // The input shows what is typed; the query waits for the typing to pause.
  const [value, setValue] = useState('');
  const [appliedValue, setAppliedValue] = useState('');
  const applyValue = useDebouncedCallback(setAppliedValue, FILTER_DEBOUNCE_MS);
  const [sort, setSort] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [fn, setFn] = useState<Aggregate>('count');
  const [measure, setMeasure] = useState('');
  const [histogramColumn, setHistogramColumn] = useState('');
  const [seriesColumn, setSeriesColumn] = useState('');
  const [unit, setUnit] = useState<Unit>('day');
  const [page, setPage] = useState({ key: '', offset: 0 });
  const [result, setResult] = useState<{ mode: Mode } & QueryResult>();
  const [expectedColumns, setExpectedColumns] = useState<string[]>();
  const [openingExport, setOpeningExport] = useState(false);
  const current = useRef<AnalyticsDataset | undefined>(undefined);
  const loadGeneration = useRef(0);
  const staged = useRef(takeAnalyticsFile());

  const numericColumns = useMemo(
    () => dataset?.columns.filter((c) => isNumericColumn(c.type)) ?? [],
    [dataset],
  );
  const temporalColumns = useMemo(
    () => dataset?.columns.filter((c) => isTemporalColumn(c.type)) ?? [],
    [dataset],
  );

  /** Forgets the dataset and everything chosen for it. */
  const resetView = useCallback(() => {
    setDataset(undefined);
    setResult(undefined);
    setMode('rows');
    setColumn('');
    setSort('');
    setValue('');
    setAppliedValue('');
    // A keystroke still waiting would bring the old text back.
    applyValue('');
    setGroupBy('');
    setMeasure('');
    setFn('count');
    setHistogramColumn('');
    setSeriesColumn('');
    setLoading(false);
    setSettled('');
  }, [applyValue]);

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
    resetView();
    setError(false);
    setCancelled(false);
    setFile(next);
    if (!next) return;
    // DuckDB reports no progress while it reads a file, so this is indeterminate.
    setLoading(true);
    try {
      const loaded = await loadLocalFile(next);
      if (generation !== loadGeneration.current) {
        await disposeDataset(loaded);
        return;
      }
      current.current = loaded;
      // Useful starting choices: group by the first text column and sum the
      // first number; chart the first number and the first date.
      const numbers = loaded.columns.filter((c) => isNumericColumn(c.type));
      const group = loaded.columns.find((c) => !isNumericColumn(c.type));
      setGroupBy((group ?? loaded.columns[0])?.name ?? '');
      const measured = numbers.find((c) => c.name !== group?.name);
      setMeasure(measured?.name ?? '');
      setFn(measured ? 'sum' : 'count');
      setHistogramColumn(numbers[0]?.name ?? '');
      setSeriesColumn(
        loaded.columns.find((c) => isTemporalColumn(c.type))?.name ?? '',
      );
      setDataset(loaded);
    } catch {
      if (generation === loadGeneration.current) setError(true);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  /**
   * Stops a running load or query. DuckDB cannot interrupt a running statement in
   * this build, so the session is closed, which ends its worker: the file has to
   * be chosen again.
   */
  const cancel = () => {
    loadGeneration.current += 1;
    terminateAnalyticsEngine();
    current.current = undefined;
    resetView();
    setFile(undefined);
    setOpeningExport(false);
    setCancelled(true);
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
      resetView();
      setFile(undefined);
    }
  }, [enabled, resetView]);

  useEffect(() => {
    if (activeIdentity.current === identity) return;
    activeIdentity.current = identity;
    loadGeneration.current += 1;
    terminateAnalyticsEngine();
    current.current = undefined;
    resetView();
    setFile(undefined);
  }, [identity, resetView]);

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

  const filters: DatasetFilter[] | undefined =
    column &&
    (appliedValue || operator === 'isNull' || operator === 'isNotNull')
      ? [{ column, operator, value: appliedValue }]
      : undefined;
  const aggregate: DatasetQuery['aggregate'] =
    fn === 'count' || !measure ? { fn: 'count' } : { column: measure, fn };
  // The query for the current choices, or nothing while a mode lacks its column.
  const shape: DatasetQuery | undefined =
    mode === 'rows'
      ? sort
        ? { sort: { column: sort, direction: 'asc' } }
        : {}
      : mode === 'group'
        ? groupBy
          ? {
              groupBy,
              aggregate,
              sort: { column: 'value', direction: 'desc' },
            }
          : undefined
        : mode === 'histogram'
          ? histogramColumn
            ? { histogram: { column: histogramColumn, bins: HISTOGRAM_BINS } }
            : undefined
          : seriesColumn
            ? {
                timeSeries: { column: seriesColumn, unit },
                ...(aggregate.fn === 'count' ? {} : { aggregate }),
              }
            : undefined;
  // Everything but the page: another value here returns to the first page.
  const queryKey = JSON.stringify({ mode, shape, filters });
  const offset = page.key === queryKey ? page.offset : 0;
  const request: DatasetQuery | undefined = shape && {
    offset,
    limit: MAX_ROWS,
    ...(filters ? { filters } : {}),
    ...shape,
  };
  const requestJson = JSON.stringify(request);
  const requestId =
    dataset && requestJson ? `${dataset.id}:${requestJson}` : '';
  const running = requestId !== '' && settled !== requestId;

  useEffect(() => {
    if (!dataset || !requestJson) return;
    // A newer request aborts this one: the engine skips it if it has not
    // started, and its answer is ignored if it has.
    const controller = new AbortController();
    queryDataset(dataset, JSON.parse(requestJson) as DatasetQuery, {
      signal: controller.signal,
    })
      .then((rows) => {
        if (controller.signal.aborted) return;
        setResult({ mode, ...rows });
        setError(false);
        setSettled(`${dataset.id}:${requestJson}`);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbort(reason)) return;
        setError(true);
        setSettled(`${dataset.id}:${requestJson}`);
      });
    return () => controller.abort();
  }, [dataset, requestJson, mode]);

  if (pending) return <Skeleton className="h-40 w-full" aria-busy />;
  if (!enabled) return null;

  const columns = dataset?.columns ?? [];
  const names = columns.map((c) => ({ value: c.name, label: c.name }));
  const numberNames = numericColumns.map((c) => ({
    value: c.name,
    label: c.name,
  }));
  const busy = loading || running || openingExport;
  const shown = result?.mode === mode ? result : undefined;
  const valueLabel =
    fn === 'count' || !measure
      ? t('aggregates.count')
      : `${t(`aggregates.${fn}`)} ${measure}`;

  return (
    <section className="flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <FileUpload
        value={file ? [file] : []}
        onValueChange={(next) => void start(next.at(-1))}
        maxFiles={1}
        accept=".csv,.json,.jsonl,.ndjson,.parquet"
        label={t('file')}
        onFileReject={(rejected, message) =>
          toast.error(t('rejected', { name: rejected.name, reason: message }))
        }
      >
        <FileUploadDropzone>
          <div className="flex flex-col items-center gap-1 text-center">
            <UploadIcon className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t('drop')}</p>
            <p className="text-xs text-muted-foreground">{t('formats')}</p>
          </div>
          <FileUploadTrigger
            render={<Button variant="outline" size="sm" type="button" />}
          >
            {t('choose')}
          </FileUploadTrigger>
        </FileUploadDropzone>
        <FileUploadList>
          {file && (
            <FileUploadItem value={file}>
              <FileUploadItemPreview />
              <FileUploadItemMetadata />
              <FileUploadItemDelete
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={t('closeFile')}
                  />
                }
              >
                <XIcon />
              </FileUploadItemDelete>
            </FileUploadItem>
          )}
        </FileUploadList>
      </FileUpload>
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
      {busy && (
        <div className="flex items-center gap-3">
          <Spinner aria-hidden role="presentation" />
          <p role="status" className="text-sm text-muted-foreground">
            {loading
              ? t('loading')
              : openingExport
                ? t('openingExport')
                : t('running')}
          </p>
          <Button variant="outline" size="sm" onClick={cancel}>
            {t('cancel')}
          </Button>
        </div>
      )}
      {cancelled && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('cancelled')}
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
          <Card>
            <CardHeader>
              <CardTitle>{t('explore')}</CardTitle>
              <CardDescription>{t('filterHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <OptionSelect
                  id="analytics-filter-column"
                  label={t('filterColumn')}
                  value={column}
                  onValueChange={setColumn}
                  options={names}
                  empty={t('allColumns')}
                />
                <OptionSelect
                  id="analytics-operator"
                  label={t('operator')}
                  value={operator}
                  onValueChange={(next) => setOperator(next as Operator)}
                  options={OPERATORS.map((item) => ({
                    value: item,
                    label: t(`operators.${item}`),
                  }))}
                />
                <Field>
                  <FieldLabel htmlFor="analytics-value">
                    {t('value')}
                  </FieldLabel>
                  <Input
                    id="analytics-value"
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value);
                      applyValue(event.target.value);
                    }}
                  />
                </Field>
              </div>
              <Tabs
                value={mode}
                onValueChange={(next) => setMode(next as Mode)}
              >
                <TabsList>
                  <TabsTrigger value="rows">{t('modes.rows')}</TabsTrigger>
                  <TabsTrigger value="group">{t('modes.group')}</TabsTrigger>
                  <TabsTrigger
                    value="histogram"
                    disabled={numericColumns.length === 0}
                  >
                    {t('modes.histogram')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="series"
                    disabled={temporalColumns.length === 0}
                  >
                    {t('modes.series')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="rows" className="pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <OptionSelect
                      id="analytics-sort"
                      label={t('sort')}
                      value={sort}
                      onValueChange={setSort}
                      options={names}
                      empty={t('noSort')}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="group" className="pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <OptionSelect
                      id="analytics-group-by"
                      label={t('groupBy')}
                      value={groupBy}
                      onValueChange={setGroupBy}
                      options={names}
                    />
                    <AggregateControls
                      fn={fn}
                      measure={measure}
                      onFn={setFn}
                      onMeasure={setMeasure}
                      numbers={numberNames}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="histogram" className="pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <OptionSelect
                      id="analytics-histogram-column"
                      label={t('histogramColumn')}
                      value={histogramColumn}
                      onValueChange={setHistogramColumn}
                      options={numberNames}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="series" className="pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <OptionSelect
                      id="analytics-series-column"
                      label={t('seriesColumn')}
                      value={seriesColumn}
                      onValueChange={setSeriesColumn}
                      options={temporalColumns.map((c) => ({
                        value: c.name,
                        label: c.name,
                      }))}
                    />
                    <OptionSelect
                      id="analytics-unit"
                      label={t('unit')}
                      value={unit}
                      onValueChange={(next) => setUnit(next as Unit)}
                      options={UNITS.map((item) => ({
                        value: item,
                        label: t(`units.${item}`),
                      }))}
                    />
                    <AggregateControls
                      fn={fn}
                      measure={measure}
                      onFn={setFn}
                      onMeasure={setMeasure}
                      numbers={numberNames}
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
          {shown && mode !== 'rows' && (
            <ResultChart kind={mode} result={shown} valueLabel={valueLabel} />
          )}
          <div className="overflow-auto rounded-md border" aria-busy={running}>
            <Table aria-label={t('results')}>
              <TableHeader>
                <TableRow>
                  {(shown?.columns ?? []).map((name) => (
                    <TableHead key={name}>{name}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(shown?.rows ?? []).map((row, index) => (
                  <TableRow key={index}>
                    {(shown?.columns ?? []).map((name) => (
                      <TableCell key={name}>{display(row[name])}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('shown', {
              shown: shown?.rows.length ?? 0,
              total: shown?.totalRows ?? 0,
              max: MAX_ROWS,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() =>
                setPage({
                  key: queryKey,
                  offset: Math.max(0, offset - MAX_ROWS),
                })
              }
            >
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              disabled={offset + MAX_ROWS >= (shown?.totalRows ?? 0)}
              onClick={() =>
                setPage({ key: queryKey, offset: offset + MAX_ROWS })
              }
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** The aggregate function and the number it measures (count needs none). */
function AggregateControls(props: {
  fn: Aggregate;
  measure: string;
  onFn: (fn: Aggregate) => void;
  onMeasure: (column: string) => void;
  numbers: { value: string; label: string }[];
}) {
  const { t } = useTranslation('analytics');
  const noNumbers = props.numbers.length === 0;
  return (
    <>
      <OptionSelect
        id="analytics-aggregate"
        label={t('aggregate')}
        value={props.fn}
        onValueChange={(next) => props.onFn(next as Aggregate)}
        options={AGGREGATES.filter(
          (item) => item === 'count' || !noNumbers,
        ).map((item) => ({ value: item, label: t(`aggregates.${item}`) }))}
      />
      <OptionSelect
        id="analytics-measure"
        label={t('measure')}
        value={props.measure}
        onValueChange={props.onMeasure}
        options={props.numbers}
        disabled={props.fn === 'count' || noNumbers}
      />
    </>
  );
}
