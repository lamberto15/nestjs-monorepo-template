import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Label } from '@nestjs-monorepo-template/ui/components/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { changeField, withConditions, withFields } from './api';
import {
  addDays,
  addMonths,
  bounds,
  calendarDay,
  isDay,
  movedTo,
  startOfMonth,
  startOfWeek,
  today,
  type Day,
} from './dates';
import { RecordSummary, titleOf, useRecordRows, type ViewProps } from './rows';
import { useMe } from '@/lib/features';
import { fetchPage, listFilters, type ListPageData } from '@/lib/list-query';
import { useInvalidateRecords, useRecordCan, recordKeys } from '@/lib/records';

type Item = { id: string; can?: { update?: boolean } } & Record<
  string,
  unknown
>;
type Mode = 'month' | 'week' | 'agenda';
const MODES: Mode[] = ['month', 'week', 'agenda'];
/** Days an agenda lists from its start. */
const AGENDA_DAYS = 30;

/** 0 = Sunday … 6 = Saturday: the week's first day in the language (Monday when the browser does not say). */
function firstDayOf(language: string): number {
  const locale = new Intl.Locale(language) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1;
  return first % 7;
}

/** The days a mode shows around `anchor`, from (included) to (excluded). */
function visibleRange(mode: Mode, anchor: Day, firstDay: number): [Day, Day] {
  if (mode === 'agenda') return [anchor, addDays(anchor, AGENDA_DAYS)];
  if (mode === 'week') {
    const start = startOfWeek(anchor, firstDay);
    return [start, addDays(start, 7)];
  }
  // A month is shown as six whole weeks.
  const start = startOfWeek(startOfMonth(anchor), firstDay);
  return [start, addDays(start, 42)];
}

function step(mode: Mode, anchor: Day, direction: 1 | -1): Day {
  if (mode === 'month') return addMonths(anchor, direction);
  return addDays(anchor, direction * (mode === 'week' ? 7 : AGENDA_DAYS));
}

/**
 * Records on a month, a week or an agenda of a date field (`views.calendar`).
 * Only the visible range is asked for: the list's `filter` and `q`, and the
 * field from the range's start up to its end. A `date` field is an all-day
 * entry on its day; a `datetime` is on the day it falls on in the user's
 * time zone, with its time. Moving an entry to another day goes through the
 * record's update route (ETag, permissions, validation), keeping a moment's
 * time of day; the agenda is the list a keyboard and a screen reader walk.
 */
export function Calendar(
  props: ViewProps & { subject: string; fields: string[]; readOnly: boolean },
) {
  const { path, pathParams, description, extra, params } = props;
  const { t, i18n } = useTranslation('record-views');
  const zone = useMe()?.user.timezone ?? undefined;
  const canOf = useRecordCan(props.subject);
  const invalidate = useInvalidateRecords(path);
  const queryClient = useQueryClient();
  const [field, setField] = useState(props.fields[0] as string);
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState<Day>(() => today(zone));
  const [moving, setMoving] = useState<Item | null>(null);
  const meta = description.fields.find((f) => f.name === field);
  const type = meta?.type === 'date' ? 'date' : 'datetime';
  const firstDay = firstDayOf(i18n.language);
  const [from, to] = visibleRange(mode, anchor, firstDay);

  const [lower, upper] = bounds(from, to, type, zone);
  const query = {
    ...extra,
    ...withConditions(listFilters(params), [
      { field, op: 'gte', value: lower },
      { field, op: 'lt', value: upper },
    ]),
    ...(meta?.sortable && { sort: field }),
    fields: withFields(params, [field], description),
    page: '1',
    limit: String(description.limits.maxLimit),
    count: 'true',
  };
  const result = useQuery({
    queryKey: [...recordKeys.lists(path), 'calendar', query, pathParams],
    queryFn: () =>
      fetchPage(path as never, query, pathParams) as Promise<
        ListPageData<Item>
      >,
  });
  const items = result.data?.items ?? [];
  const rows = useRecordRows(items, props.columns, props.visibility);
  const rowOf = new Map(rows.map((row) => [row.id, row]));

  const byDay = useMemo(() => {
    const days = new Map<Day, Item[]>();
    for (const item of items) {
      const value = item[field];
      if (typeof value !== 'string') continue;
      const day = calendarDay(value, type, zone);
      days.set(day, [...(days.get(day) ?? []), item]);
    }
    return days;
  }, [items, field, type, zone]);

  const reschedule = useMutation({
    mutationFn: async ({ item, day }: { item: Item; day: Day }) => {
      const applied = await changeField(
        path,
        item.id,
        field,
        movedTo(item[field] as string, type, day, zone),
      );
      if (!applied) toast.error(t('calendar.notApplied'));
      return applied;
    },
    onSuccess: (applied) => {
      if (applied) setMoving(null);
    },
    onSettled: () => {
      void invalidate();
    },
  });

  const format = (options: Intl.DateTimeFormatOptions, day: Day) =>
    new Intl.DateTimeFormat(i18n.language, {
      ...options,
      timeZone: 'UTC',
    }).format(new Date(`${day}T00:00:00Z`));
  const time = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      timeStyle: 'short',
      ...(zone && { timeZone: zone }),
    }).format(new Date(value));

  const days = Array.from(
    { length: mode === 'month' ? 42 : mode === 'week' ? 7 : AGENDA_DAYS },
    (_, i) => addDays(from, i),
  );
  const title =
    mode === 'month'
      ? format({ month: 'long', year: 'numeric' }, anchor)
      : `${format({ dateStyle: 'medium' }, from)} – ${format({ dateStyle: 'medium' }, addDays(to, -1))}`;

  const entry = (item: Item, compact: boolean) => {
    const row = rowOf.get(item.id);
    const value = item[field] as string;
    const label = row ? titleOf(row) : item.id;
    return (
      <li
        key={item.id}
        className="flex items-start gap-1 rounded-md border bg-card p-1.5 text-card-foreground"
      >
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {type === 'date' ? t('calendar.allDay') : time(value)}
          </p>
          {row && (
            <RecordSummary
              row={row}
              compact={compact}
              href={props.rowHref?.(item as never)}
            />
          )}
        </div>
        {!props.readOnly && !props.paused && canOf(item).update && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('calendar.reschedule', { title: label })}
            className="pointer-coarse:size-10"
            onClick={() => setMoving(item)}
          >
            <CalendarClockIcon aria-hidden />
          </Button>
        )}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3" data-slot="record-calendar">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('calendar.previous')}
          onClick={() => setAnchor(step(mode, anchor, -1))}
        >
          <ChevronLeftIcon aria-hidden className="rtl:rotate-180" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('calendar.next')}
          onClick={() => setAnchor(step(mode, anchor, 1))}
        >
          <ChevronRightIcon aria-hidden className="rtl:rotate-180" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnchor(today(zone))}
        >
          {t('calendar.today')}
        </Button>
        <h3 aria-live="polite" className="me-auto text-sm font-medium">
          {title}
        </h3>
        {props.fields.length > 1 && (
          <select
            aria-label={t('calendar.field')}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={field}
            onChange={(event) => setField(event.target.value)}
          >
            {props.fields.map((name) => (
              <option key={name} value={name}>
                {description.fields.find((f) => f.name === name)?.label ?? name}
              </option>
            ))}
          </select>
        )}
        <div
          role="group"
          aria-label={t('calendar.mode')}
          className="flex gap-1"
        >
          {MODES.map((name) => (
            <Button
              key={name}
              size="sm"
              variant={name === mode ? 'default' : 'outline'}
              aria-pressed={name === mode}
              onClick={() => setMode(name)}
            >
              {t(`calendar.modes.${name}`)}
            </Button>
          ))}
        </div>
      </div>
      {result.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('calendar.failed')}
        </p>
      ) : mode === 'agenda' ? (
        <ol aria-busy={result.isFetching} className="flex flex-col gap-3">
          {days
            .filter((day) => byDay.has(day))
            .map((day) => (
              <li key={day}>
                <h4 className="mb-1 text-sm font-medium">
                  {format({ dateStyle: 'full' }, day)}
                </h4>
                <ul className="flex flex-col gap-1.5">
                  {byDay.get(day)?.map((item) => entry(item, false))}
                </ul>
              </li>
            ))}
          {!result.isPending && byDay.size === 0 && (
            <li className="text-sm text-muted-foreground">
              {t('calendar.empty')}
            </li>
          )}
        </ol>
      ) : (
        <div className="overflow-x-auto">
          <ol
            aria-busy={result.isFetching}
            className={`grid min-w-[44rem] grid-cols-7 gap-1 ${mode === 'week' ? 'auto-rows-fr' : ''}`}
          >
            {days.map((day) => (
              <li
                key={day}
                className={`min-h-24 rounded-md border p-1 ${mode === 'month' && day.slice(0, 7) !== anchor.slice(0, 7) ? 'bg-muted/40' : ''}`}
              >
                <h4
                  className={`mb-1 text-xs ${day === today(zone) ? 'font-bold' : 'text-muted-foreground'}`}
                  aria-label={format({ dateStyle: 'full' }, day)}
                >
                  {mode === 'month'
                    ? format({ day: 'numeric' }, day)
                    : format({ weekday: 'short', day: 'numeric' }, day)}
                </h4>
                <ul className="flex flex-col gap-1">
                  {byDay.get(day)?.map((item) => entry(item, mode === 'month'))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      )}
      {result.data?.total !== undefined && result.data.total > items.length && (
        <p className="text-sm text-muted-foreground">
          {t('calendar.truncated', {
            shown: items.length,
            total: result.data.total,
          })}
        </p>
      )}
      {moving && (
        <RescheduleDialog
          title={
            rowOf.get(moving.id) ? titleOf(rowOf.get(moving.id)!) : moving.id
          }
          current={calendarDay(moving[field] as string, type, zone)}
          pending={reschedule.isPending}
          onClose={() => setMoving(null)}
          onSubmit={(day) => reschedule.mutate({ item: moving, day })}
        />
      )}
    </div>
  );
}

function RescheduleDialog(props: {
  title: string;
  current: Day;
  pending: boolean;
  onClose: () => void;
  onSubmit: (day: Day) => void;
}) {
  const { t } = useTranslation('record-views');
  const [value, setValue] = useState<string>(props.current);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t('calendar.rescheduleTitle', { title: props.title })}
          </DialogTitle>
          <DialogDescription>
            {t('calendar.rescheduleDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isDay(value)) {
              setError(t('calendar.invalidDay'));
            } else if (value === props.current) {
              setError(t('calendar.sameDay'));
            } else {
              setError(null);
              props.onSubmit(value);
            }
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reschedule-day">{t('calendar.newDay')}</Label>
            <Input
              id="reschedule-day"
              type="date"
              autoFocus
              value={value}
              aria-invalid={error !== null}
              aria-describedby={error ? 'reschedule-error' : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
            {error && (
              <p
                id="reschedule-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              {t('calendar.cancel')}
            </Button>
            <Button type="submit" disabled={props.pending}>
              {t('calendar.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
