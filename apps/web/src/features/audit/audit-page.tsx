import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Label } from '@nestjs-monorepo-template/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchAudit,
  noFilters,
  type AuditEntry,
  type AuditFilters,
} from './api';
import { PersonName } from '@/components/person-name';
import { errorMessage } from '@/lib/errors';
import { useDateTimeFormat } from '@/lib/date-time';

/** Details as text: a string as is, anything else as indented JSON. Never HTML. */
export function detailsText(details: unknown): string {
  if (details === null || details === undefined) {
    return '';
  }
  return typeof details === 'string'
    ? details
    : (JSON.stringify(details, null, 2) ?? '');
}

/** The audit log (`GET /v1/access/audit`): filters, server paging, details. */
export function AuditPage() {
  const { t } = useTranslation('audit');
  const [draft, setDraft] = useState<AuditFilters>(noFilters);
  const [applied, setApplied] = useState<AuditFilters>(noFilters);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const format = useDateTimeFormat();
  const log = useQuery({
    queryKey: ['audit', applied, page] as const,
    queryFn: () => fetchAudit(applied, page),
    placeholderData: keepPreviousData,
  });
  const set = (key: keyof AuditFilters) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-medium">{t('title')}</h1>
      <form
        className="flex flex-wrap items-end gap-3"
        role="search"
        aria-label={t('filters.label')}
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(draft);
          setPage(1);
          setOpen(null);
        }}
      >
        <FilterInput
          id="audit-action"
          label={t('filters.action')}
          placeholder="note."
          value={draft.action}
          onChange={set('action')}
        />
        <FilterInput
          id="audit-actor"
          label={t('filters.actor')}
          placeholder="user:…"
          value={draft.actor}
          onChange={set('actor')}
        />
        <FilterInput
          id="audit-subject"
          label={t('filters.subject')}
          placeholder="note"
          value={draft.targetType}
          onChange={set('targetType')}
        />
        <FilterInput
          id="audit-from"
          type="date"
          label={t('filters.from')}
          value={draft.from}
          onChange={set('from')}
        />
        <FilterInput
          id="audit-to"
          type="date"
          label={t('filters.to')}
          value={draft.to}
          onChange={set('to')}
        />
        <Button type="submit">{t('filters.apply')}</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft(noFilters);
            setApplied(noFilters);
            setPage(1);
            setOpen(null);
          }}
        >
          {t('filters.reset')}
        </Button>
      </form>

      {log.isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-destructive/40 p-4 text-sm"
        >
          <p>{errorMessage(log.error)}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void log.refetch()}
          >
            {t('retry')}
          </Button>
        </div>
      ) : log.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('loading')}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t('columns.at')}</TableHead>
                <TableHead>{t('columns.actor')}</TableHead>
                <TableHead>{t('columns.action')}</TableHead>
                <TableHead>{t('columns.target')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center">
                    {t('empty')}
                  </TableCell>
                </TableRow>
              )}
              {log.data.items.map((entry) => (
                <EntryRows
                  key={entry.id}
                  entry={entry}
                  open={open === entry.id}
                  onToggle={() => setOpen(open === entry.id ? null : entry.id)}
                  when={format(entry.at)}
                />
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span aria-live="polite">
              {t('page', {
                page: log.data.page ?? page,
                pages: log.data.pageCount ?? 1,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!log.data.nextPage}
                onClick={() => setPage(page + 1)}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function FilterInput(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type}
        placeholder={props.placeholder}
        className="w-44"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function EntryRows(props: {
  entry: AuditEntry;
  when: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('audit');
  const { entry } = props;
  const text = detailsText(entry.details);
  const Icon = props.open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <Fragment>
      <TableRow>
        <TableCell>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={props.open}
            aria-label={t('details.toggle', { action: entry.action })}
            onClick={props.onToggle}
          >
            <Icon />
          </Button>
        </TableCell>
        <TableCell>{props.when}</TableCell>
        <TableCell>
          {entry.actorLabel ?? <PersonName value={entry.actor} />}
        </TableCell>
        <TableCell className="font-mono text-xs">{entry.action}</TableCell>
        <TableCell>
          {entry.targetType
            ? `${entry.targetType}${entry.targetId ? ` ${entry.targetId}` : ''}`
            : ''}
        </TableCell>
      </TableRow>
      {props.open && (
        <TableRow>
          <TableCell colSpan={5}>
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
              <dt className="text-muted-foreground">{t('details.actor')}</dt>
              <dd className="font-mono">{entry.actor}</dd>
              {entry.ip && (
                <>
                  <dt className="text-muted-foreground">{t('details.ip')}</dt>
                  <dd className="font-mono">{entry.ip}</dd>
                </>
              )}
            </dl>
            {/* Text in a <pre>: React escapes it, nothing is parsed as HTML. */}
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {text || t('details.none')}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
