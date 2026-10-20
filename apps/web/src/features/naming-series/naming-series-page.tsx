import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
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
import { useQuery } from '@tanstack/react-query';
import {
  GaugeIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { errorMessage } from '@/lib/errors';
import {
  allNamingSeriesQuery,
  numberedSubjectsQuery,
  type NamingSeries,
} from '@/lib/naming-series';
import { useDeleteSeries, useUpdateSeries } from './api';
import { CounterDialog } from './counter-dialog';
import { SeriesDialog } from './series-dialog';

/** The filter's "every subject" (a subject's name is a Pascal-case word). */
const ALL = '*';

const OPERATOR_SYMBOL = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
} as const;

/** What picks a series for a record, briefly: conditions, priority, date. */
function Rules(props: { series: NamingSeries }) {
  const { t } = useTranslation('naming-series');
  const { conditions, priority, dateField } = props.series;
  if (conditions.length === 0 && priority === 0 && !dateField) {
    return <span className="text-muted-foreground">–</span>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {conditions.length > 0 && (
        <ul aria-label={t('rules.conditions')} className="flex flex-wrap gap-1">
          {conditions.map((c, i) => (
            <li key={i}>
              <Badge variant="outline" className="font-mono">
                {`${c.field} ${OPERATOR_SYMBOL[c.op]} ${String(c.value)}`}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {(conditions.length > 0 || priority !== 0) && (
        <span className="text-xs text-muted-foreground">
          {t('rules.priority', { priority })}
        </span>
      )}
      {dateField && (
        <span className="text-xs text-muted-foreground">
          {t('rules.dateFrom', { field: dateField })}
        </span>
      )}
    </div>
  );
}

/**
 * The record number formats (docs/sequences.md): the series of every subject
 * that numbers its records, with the number each gives next. Create and edit a
 * pattern with a live preview, make one the default, set its counter, delete
 * it. A subject with no series numbers its records by the format in code,
 * listed under the table.
 */
export function NamingSeriesPage() {
  const { t } = useTranslation('naming-series');
  const series = useQuery({
    ...allNamingSeriesQuery,
    meta: { errorToast: false },
  });
  const subjectsQuery = useQuery({
    ...numberedSubjectsQuery,
    meta: { errorToast: false },
  });
  const update = useUpdateSeries();
  const remove = useDeleteSeries();
  const [chosen, setChosen] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NamingSeries>();
  const [counting, setCounting] = useState<NamingSeries>();
  const [deleting, setDeleting] = useState<NamingSeries>();
  // Kept after the dialog closes, so its closing animation still has its text.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const subjects = (subjectsQuery.data ?? []).toSorted((a, b) =>
    a.subject.localeCompare(b.subject),
  );
  const subject = subjects.some((s) => s.subject === chosen) ? chosen : ALL;
  const all = series.data ?? [];
  const shown = all
    .filter((s) => subject === ALL || s.subject === subject)
    .toSorted(
      (a, b) =>
        a.subject.localeCompare(b.subject) ||
        a.pattern.localeCompare(b.pattern),
    );
  const withSeries = new Set(all.map((s) => s.subject));
  const inCode = subjects.filter(
    (s) =>
      !withSeries.has(s.subject) && (subject === ALL || s.subject === subject),
  );

  const makeDefault = async (row: NamingSeries) => {
    try {
      await update.mutateAsync({ id: row.id, changes: { isDefault: true } });
      toast.success(t('defaultSet', { pattern: row.pattern }));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field className="w-full sm:w-56">
          <FieldLabel htmlFor="series-filter">{t('subject')}</FieldLabel>
          <Select
            items={[
              { value: ALL, label: t('allSubjects') },
              ...subjects.map((s) => ({ value: s.subject, label: s.subject })),
            ]}
            value={subject}
            onValueChange={(next) => next && setChosen(next)}
          >
            <SelectTrigger id="series-filter" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allSubjects')}</SelectItem>
              {subjects.map((s) => (
                <SelectItem key={s.subject} value={s.subject}>
                  {s.subject}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button
          disabled={subjects.length === 0}
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
          {t('new')}
        </Button>
      </div>

      {series.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {series.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(series.error)}
        </p>
      )}
      {series.isSuccess &&
        (shown.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('none')}
          </p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.subject')}</TableHead>
                  <TableHead>{t('columns.pattern')}</TableHead>
                  <TableHead>{t('columns.label')}</TableHead>
                  <TableHead>{t('columns.rules')}</TableHead>
                  <TableHead>{t('columns.next')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.subject}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs">{row.pattern}</code>
                        {row.isDefault && <Badge>{t('default')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.label}
                    </TableCell>
                    <TableCell>
                      <Rules series={row} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.example}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!row.isDefault && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('makeDefault', {
                              pattern: row.pattern,
                            })}
                            disabled={update.isPending}
                            onClick={() => void makeDefault(row)}
                          >
                            <StarIcon />
                            {t('makeDefaultButton')}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('counterOf', { pattern: row.pattern })}
                          onClick={() => setCounting(row)}
                        >
                          <GaugeIcon />
                          {t('counterButton')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('edit', { pattern: row.pattern })}
                          onClick={() => setEditing(row)}
                        >
                          <PencilIcon />
                          {t('editButton')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('delete', { pattern: row.pattern })}
                          onClick={() => {
                            setDeleting(row);
                            setConfirmingDelete(true);
                          }}
                        >
                          <Trash2Icon />
                          {t('deleteButton')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}

      {inCode.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{t('inCodeTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('inCodeHint')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {inCode.map((s) => (
              <li key={s.subject} className="flex items-center gap-2">
                <span>{s.subject}</span>
                <code className="font-mono text-xs text-muted-foreground">
                  {s.declaredPattern}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {creating && (
        <SeriesDialog
          subjects={subjects}
          subject={subject === ALL ? undefined : subject}
          onOpenChange={(open) => !open && setCreating(false)}
        />
      )}
      {editing && (
        <SeriesDialog
          // A fresh form for each series.
          key={editing.id}
          series={editing}
          subjects={subjects}
          onOpenChange={(open) => !open && setEditing(undefined)}
        />
      )}
      {counting && (
        <CounterDialog
          key={counting.id}
          series={counting}
          onOpenChange={(open) => !open && setCounting(undefined)}
        />
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('deleteTitle', { pattern: deleting?.pattern })}
        description={t('deleteDescription', { subject: deleting?.subject })}
        confirm={t('deleteConfirm')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          toast.success(t('deleted'));
        }}
      />
    </div>
  );
}
