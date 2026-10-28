import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { withConditions, withFields } from './api';
import {
  addDays,
  addMonths,
  bounds,
  instantAt,
  startOfMonth,
  startOfWeek,
  today,
  type Day,
} from './dates';
import { RowLink, titleOf, useRecordRows, type ViewProps } from './rows';
import { useMe } from '@/lib/features';
import { fetchPage, listFilters, type ListPageData } from '@/lib/list-query';
import { recordKeys } from '@/lib/records';

type Item = { id: string } & Record<string, unknown>;
type Zoom = 'day' | 'week' | 'month';
const ZOOMS: Zoom[] = ['day', 'week', 'month'];
/** Days the window shows at each zoom. */
const WINDOW: Record<Zoom, number> = { day: 14, week: 12 * 7, month: 365 };

/** A bar's ends, in ms: a `date` runs from its day's start to the end of its last day. */
function span(
  item: Item,
  start: { name: string; type: string },
  end: { name: string; type: string },
  zone?: string,
): { from: number; to: number | null } | null {
  const at = (value: unknown, type: string, last: boolean) => {
    if (typeof value !== 'string') return null;
    return type === 'date'
      ? new Date(
          instantAt(
            last ? addDays(value.slice(0, 10), 1) : value.slice(0, 10),
            zone,
          ),
        ).getTime()
      : new Date(value).getTime();
  };
  const from = at(item[start.name], start.type, false);
  if (from === null) return null;
  return { from, to: at(item[end.name], end.type, true) };
}

/**
 * Records as bars from a start field to an end field (`views.timeline`), read
 * only. The query is bounded by the window: records that start before it
 * ends and end after it starts (or have no end yet). A record whose end is
 * before its start is not drawn: it is listed apart, so no bad range hides.
 * Zoom is the window's length (days, weeks, months); the table below is the
 * same records as text, the alternative a screen reader and the keyboard
 * use.
 */
export function Timeline(props: ViewProps & { start: string; end: string }) {
  const { path, pathParams, description, extra, params } = props;
  const { t, i18n } = useTranslation('record-views');
  const zone = useMe()?.user.timezone ?? undefined;
  const [zoom, setZoom] = useState<Zoom>('week');
  const [anchor, setAnchor] = useState<Day>(() => today(zone));
  const [chart, setChart] = useState(true);
  const meta = (name: string) => {
    const found = description.fields.find((f) => f.name === name);
    return {
      name,
      type: found?.type === 'date' ? 'date' : 'datetime',
    } as const;
  };
  const start = meta(props.start);
  const end = meta(props.end);

  const from =
    zoom === 'month'
      ? startOfMonth(anchor)
      : zoom === 'week'
        ? startOfWeek(anchor, 1)
        : anchor;
  const to =
    zoom === 'month' ? addMonths(from, 12) : addDays(from, WINDOW[zoom]);
  const [, windowEnd] = bounds(from, to, start.type, zone);
  const [endLower] = bounds(from, to, end.type, zone);
  const query = {
    ...extra,
    ...withConditions(listFilters(params), [
      { field: start.name, op: 'lt', value: windowEnd },
      {
        or: [
          { field: end.name, op: 'gte', value: endLower },
          { field: end.name, op: 'isNull', value: true },
        ],
      },
    ]),
    sort: start.name,
    fields: withFields(params, [start.name, end.name], description),
    page: '1',
    limit: String(description.limits.maxLimit),
    count: 'true',
  };
  const result = useQuery({
    queryKey: [...recordKeys.lists(path), 'timeline', query, pathParams],
    queryFn: () =>
      fetchPage(path as never, query, pathParams) as Promise<
        ListPageData<Item>
      >,
  });
  const items = result.data?.items ?? [];
  const drawn: { item: Item; from: number; to: number | null }[] = [];
  const invalid: Item[] = [];
  for (const item of items) {
    const range = span(item, start, end, zone);
    if (!range) continue;
    if (range.to !== null && range.to < range.from) invalid.push(item);
    else drawn.push({ item, ...range });
  }

  const rows = useRecordRows(items, props.columns, props.visibility);
  const rowOf = new Map(rows.map((row) => [row.id, row]));
  // The window's ends as instants, whatever the field's type.
  const lo = new Date(instantAt(from, zone)).getTime();
  const hi = new Date(instantAt(to, zone)).getTime();
  const pct = (ms: number) =>
    Math.min(100, Math.max(0, ((ms - lo) / (hi - lo)) * 100));
  const label = (item: Item) => {
    const row = rowOf.get(item.id);
    return row ? titleOf(row) : item.id;
  };
  const when = (ms: number | null, type: string) =>
    ms === null
      ? t('timeline.open')
      : new Intl.DateTimeFormat(i18n.language, {
          dateStyle: 'medium',
          ...(type !== 'date' && { timeStyle: 'short' }),
          ...(zone && { timeZone: zone }),
        }).format(new Date(type === 'date' ? ms - 1 : ms));
  const stepBy = (direction: 1 | -1) =>
    setAnchor(
      zoom === 'month'
        ? addMonths(from, direction * 12)
        : addDays(from, direction * (WINDOW[zoom] / 2)),
    );
  const heading = (day: Day) =>
    new Intl.DateTimeFormat(i18n.language, {
      timeZone: 'UTC',
      ...(zoom === 'month'
        ? { month: 'short' }
        : { day: 'numeric', month: 'short' }),
    }).format(new Date(`${day}T00:00:00Z`));
  const ticks = Array.from(
    { length: zoom === 'month' ? 12 : zoom === 'week' ? 12 : 14 },
    (_, i) =>
      zoom === 'month'
        ? addMonths(from, i)
        : addDays(from, i * (zoom === 'week' ? 7 : 1)),
  );

  return (
    <div className="flex flex-col gap-3" data-slot="record-timeline">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('timeline.previous')}
          onClick={() => stepBy(-1)}
        >
          <ChevronLeftIcon aria-hidden className="rtl:rotate-180" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('timeline.next')}
          onClick={() => stepBy(1)}
        >
          <ChevronRightIcon aria-hidden className="rtl:rotate-180" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnchor(today(zone))}
        >
          {t('timeline.today')}
        </Button>
        <div
          role="group"
          aria-label={t('timeline.zoom')}
          className="ms-auto flex gap-1"
        >
          {ZOOMS.map((name) => (
            <Button
              key={name}
              size="sm"
              variant={name === zoom ? 'default' : 'outline'}
              aria-pressed={name === zoom}
              onClick={() => setZoom(name)}
            >
              {t(`timeline.zooms.${name}`)}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={!chart}
          onClick={() => setChart(!chart)}
        >
          {chart ? t('timeline.showList') : t('timeline.showChart')}
        </Button>
      </div>
      {result.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('timeline.failed')}
        </p>
      ) : chart ? (
        <div className="overflow-x-auto" aria-busy={result.isFetching}>
          <div className="min-w-[44rem]">
            <div
              aria-hidden
              className="relative h-6 border-b text-xs text-muted-foreground"
            >
              {ticks.map((day) => (
                <span
                  key={day}
                  className="absolute top-0 -translate-x-0"
                  style={{
                    insetInlineStart: `${pct(new Date(instantAt(day, zone)).getTime())}%`,
                  }}
                >
                  {heading(day)}
                </span>
              ))}
            </div>
            <ul className="flex flex-col gap-1 pt-1">
              {drawn.map(({ item, from: a, to: b }) => {
                const left = pct(a);
                const right = pct(b ?? hi);
                return (
                  <li key={item.id} className="relative h-7">
                    <span
                      className="absolute top-0 flex h-7 min-w-2 items-center overflow-hidden rounded bg-primary px-2 text-xs text-primary-foreground"
                      style={{
                        insetInlineStart: `${left}%`,
                        width: `${Math.max(right - left, 0.5)}%`,
                      }}
                    >
                      <RowLink
                        href={props.rowHref?.(item as never)}
                        aria-label={t('timeline.bar', {
                          title: label(item),
                          start: when(a, start.type),
                          end: when(b, end.type),
                        })}
                      >
                        {label(item)}
                      </RowLink>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : (
        <table className="w-full text-sm" aria-busy={result.isFetching}>
          <caption className="sr-only">{t('timeline.caption')}</caption>
          <thead>
            <tr className="text-start">
              <th scope="col" className="p-1 text-start">
                {t('timeline.record')}
              </th>
              <th scope="col" className="p-1 text-start">
                {t('timeline.start')}
              </th>
              <th scope="col" className="p-1 text-start">
                {t('timeline.end')}
              </th>
            </tr>
          </thead>
          <tbody>
            {drawn.map(({ item, from: a, to: b }) => (
              <tr key={item.id} className="border-t">
                <th scope="row" className="p-1 text-start font-normal">
                  <RowLink href={props.rowHref?.(item as never)}>
                    {label(item)}
                  </RowLink>
                </th>
                <td className="p-1">{when(a, start.type)}</td>
                <td className="p-1">{when(b, end.type)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!result.isPending && drawn.length === 0 && invalid.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('timeline.empty')}</p>
      )}
      {invalid.length > 0 && (
        <div
          role="note"
          className="rounded-md border border-destructive/40 p-2 text-sm"
        >
          <p className="font-medium">
            {t('timeline.invalid', { count: invalid.length })}
          </p>
          <ul className="list-disc ps-5">
            {invalid.map((item) => (
              <li key={item.id}>
                <RowLink href={props.rowHref?.(item as never)}>
                  {label(item)}
                </RowLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.data?.total !== undefined && result.data.total > items.length && (
        <p className="text-sm text-muted-foreground">
          {t('timeline.truncated', {
            shown: items.length,
            total: result.data.total,
          })}
        </p>
      )}
    </div>
  );
}
