import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, SearchIcon } from 'lucide-react';
import {
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  useQueryStates,
} from 'nuqs';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { Can, useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';
import { AddSuppressionDialog } from './add-suppression-dialog';
import {
  reasons,
  sorts,
  statuses,
  suppressionsQuery,
  useAddSuppression,
  useRemoveSuppression,
  type Suppression,
  type SuppressionReason,
} from './queries';
import { SuppressionDialog } from './suppression-dialog';

const ALL = 'all';
/** The API's own order: the newest entry first. */
const NEWEST = 'newest';

const urlState = {
  q: parseAsString,
  reason: parseAsStringLiteral(reasons),
  status: parseAsStringLiteral(statuses),
  sort: parseAsStringLiteral(sorts),
  page: parseAsInteger.withDefault(1),
};

function ReasonBadge(props: { reason: SuppressionReason }) {
  const { t } = useTranslation('suppressions');
  return (
    <Badge
      variant={
        props.reason === 'manual'
          ? 'outline'
          : props.reason === 'soft_bounce'
            ? 'secondary'
            : 'destructive'
      }
    >
      {t(`reason.${props.reason}`)}
    </Badge>
  );
}

/**
 * The mail suppression list (`GET /v1/mail/suppressions`): the addresses mail
 * is not sent to, and the ones watched for soft bounces, for the deployment's
 * operators. Filters, sort and page are in the URL; an address can be added
 * (a manual entry) and removed (after a confirmation) with
 * `MailSuppression.manage`.
 *
 * Not a `ListPage`: the API has no `GET /v1/lists/MailSuppression` (the
 * filter menu is built from it), so the filters are the few the list takes.
 */
export function SuppressionsPage() {
  const { t } = useTranslation('suppressions');
  const format = useDateTimeFormat();
  const canManage = useCan('MailSuppression.manage');
  const [filters, setFilters] = useQueryStates(urlState);
  const { q, reason, status, sort } = filters;
  // ?page=0 or below would be a 400.
  const page = Math.max(1, filters.page);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<string>();
  const [removing, setRemoving] = useState<Suppression>();
  const add = useAddSuppression();
  const remove = useRemoveSuppression();
  const list = useQuery({
    ...suppressionsQuery({
      address: q ?? undefined,
      reason: reason ?? undefined,
      status: status ?? undefined,
      sort: sort ?? undefined,
      page,
    }),
    meta: { errorToast: false },
  });
  const pageCount = list.data?.pageCount ?? 1;
  // A page with nothing on it (the last row of the last page was removed, a
  // stale ?page=): go to the last page there is, so the pager stays reachable.
  const stranded =
    page > 1 &&
    !list.isPlaceholderData &&
    list.data !== undefined &&
    list.data.items.length === 0;
  useEffect(() => {
    if (stranded) {
      const last = Math.min(page - 1, Math.max(1, pageCount));
      void setFilters({ page: last <= 1 ? null : last });
    }
  }, [stranded, page, pageCount, setFilters]);
  // A change of filter starts again at the first page.
  const filter = (change: Partial<Record<keyof typeof urlState, unknown>>) =>
    void setFilters({ ...change, page: null } as never);
  return (
    <Page>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Can permission="MailSuppression.manage">
            <Button onClick={() => setAdding(true)}>
              <PlusIcon />
              {t('add.open')}
            </Button>
          </Can>
        }
      />
      <form
        // Remounted when ?q changes (back, a link), so the box shows it.
        key={q ?? ''}
        className="flex flex-wrap items-end gap-3"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const typed = new FormData(event.currentTarget).get('q');
          filter({
            q: typeof typed === 'string' ? typed.trim() || null : null,
          });
        }}
      >
        <Field className="w-64">
          <FieldLabel htmlFor="suppression-search">
            {t('filters.address')}
          </FieldLabel>
          <Input
            id="suppression-search"
            name="q"
            type="search"
            defaultValue={q ?? ''}
            placeholder={t('filters.addressPlaceholder')}
          />
        </Field>
        <Button type="submit" variant="outline">
          <SearchIcon />
          {t('filters.search')}
        </Button>
        <Field className="w-44">
          <FieldLabel htmlFor="suppression-reason">
            {t('filters.reason')}
          </FieldLabel>
          <Select
            value={reason ?? ALL}
            onValueChange={(value) =>
              filter({ reason: value === ALL ? null : value })
            }
          >
            <SelectTrigger id="suppression-reason">
              <SelectValue>
                {(value: string) =>
                  value === ALL
                    ? t('filters.anyReason')
                    : t(`reason.${value as SuppressionReason}`)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('filters.anyReason')}</SelectItem>
              {reasons.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`reason.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-44">
          <FieldLabel htmlFor="suppression-status">
            {t('filters.status')}
          </FieldLabel>
          <Select
            value={status ?? ALL}
            onValueChange={(value) =>
              filter({ status: value === ALL ? null : value })
            }
          >
            <SelectTrigger id="suppression-status">
              <SelectValue>
                {(value: string) =>
                  value === ALL
                    ? t('filters.anyStatus')
                    : t(`status.${value as (typeof statuses)[number]}`)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('filters.anyStatus')}</SelectItem>
              {statuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`status.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-48">
          <FieldLabel htmlFor="suppression-sort">
            {t('filters.sort')}
          </FieldLabel>
          <Select
            value={sort ?? NEWEST}
            onValueChange={(value) =>
              filter({ sort: value === NEWEST ? null : value })
            }
          >
            <SelectTrigger id="suppression-sort">
              <SelectValue>
                {(value: string) =>
                  t(`sort.${value as typeof NEWEST | (typeof sorts)[number]}`)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[NEWEST, ...sorts].map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`sort.${value as typeof NEWEST | (typeof sorts)[number]}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </form>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <FormAlert message={errorMessage(list.error)} />
      ) : list.data.items.length ? (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.address')}</TableHead>
                  <TableHead>{t('columns.reason')}</TableHead>
                  <TableHead>{t('columns.source')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.skipped')}</TableHead>
                  <TableHead>{t('columns.lastSeen')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs break-all">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 font-mono text-xs"
                        onClick={() => setShown(entry.id)}
                      >
                        {entry.address}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <ReasonBadge reason={entry.reason} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {entry.source}
                    </TableCell>
                    <TableCell>
                      {entry.suppressedAt ? (
                        <span title={format(entry.suppressedAt)}>
                          {t('status.suppressed')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t('status.watching')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{entry.skipped}</TableCell>
                    <TableCell>{format(entry.lastSeenAt)}</TableCell>
                    <TableCell className="text-end">
                      {canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('remove.action', {
                            address: entry.address,
                          })}
                          onClick={() => setRemoving(entry)}
                        >
                          {t('remove.open')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {t('page', { page, count: pageCount })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => void setFilters({ page: page - 1 || null })}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!list.data.nextPage}
                onClick={() => void setFilters({ page: page + 1 })}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          title={q || reason || status ? t('emptyFiltered') : t('empty')}
        />
      )}
      {/* Mounted only while open: a cancelled draft doesn't come back. */}
      {adding && (
        <AddSuppressionDialog
          open
          onOpenChange={setAdding}
          onAdd={async (body) => {
            const entry = await add.mutateAsync(body);
            toast.success(t('add.done', { address: entry.address }));
            return entry;
          }}
        />
      )}
      <SuppressionDialog id={shown} onClose={() => setShown(undefined)} />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(undefined);
          }
        }}
        title={t('remove.title', { address: removing?.address })}
        description={t(
          removing?.reason === 'complaint'
            ? 'remove.complaint'
            : 'remove.description',
        )}
        confirm={t('remove.confirm')}
        onConfirm={async () => {
          if (!removing) {
            return;
          }
          await remove.mutateAsync(removing.id);
          toast.success(t('remove.done', { address: removing.address }));
        }}
      />
    </Page>
  );
}
