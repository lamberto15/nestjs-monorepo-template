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
import { useInfiniteQuery } from '@tanstack/react-query';
import { EyeIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { holdsQuery, SUBJECT_PATTERN, type HoldFilters } from './api';
import { HoldDialog } from './hold-dialog';
import { PlaceHoldDialog } from './place-dialog';

type Status = 'any' | 'active' | 'released';

/**
 * Legal holds (docs/retention.md): the records kept whatever a delete, the
 * recycle bin's purge, a retention rule or an account deletion would do.
 * Active and released holds, filtered by status and subject; a hold opens in
 * a dialog with its release; "Place a legal hold" makes one.
 *
 * Not a `ListPage`: the API has no `GET /v1/lists/LegalHold`, and the list
 * takes the few filters here in cursor pages.
 */
export function LegalHoldsPage() {
  const { t } = useTranslation('legal-holds');
  const format = useDateTimeFormat();
  const [status, setStatus] = useState<Status>('any');
  const [subject, setSubject] = useState('');
  const [placing, setPlacing] = useState(false);
  const [shown, setShown] = useState<string>();

  const typed = subject.trim();
  // A half-typed subject is not sent (the API would answer 400).
  const filters: HoldFilters = {
    ...(status !== 'any' && { active: status === 'active' }),
    ...(SUBJECT_PATTERN.test(typed) && { subject: typed }),
  };
  const list = useInfiniteQuery({
    ...holdsQuery(filters),
    meta: { errorToast: false },
  });
  const holds = list.data?.pages.flatMap((page) => page.items) ?? [];
  const statuses: { value: Status; label: string }[] = [
    { value: 'any', label: t('filters.anyStatus') },
    { value: 'active', label: t('status.active') },
    { value: 'released', label: t('status.released') },
  ];

  return (
    <Page>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button onClick={() => setPlacing(true)}>
            <PlusIcon />
            {t('place.button')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-full sm:w-56">
          <FieldLabel htmlFor="holds-status">{t('filters.status')}</FieldLabel>
          <Select
            items={statuses}
            value={status}
            onValueChange={(next) => next && setStatus(next as Status)}
          >
            <SelectTrigger id="holds-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statuses.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-full sm:w-64">
          <FieldLabel htmlFor="holds-subject">
            {t('filters.subject')}
          </FieldLabel>
          <Input
            id="holds-subject"
            value={subject}
            placeholder="Note"
            autoComplete="off"
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
      </div>

      {list.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {list.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(list.error)}
        </p>
      )}
      {list.isSuccess &&
        (holds.length === 0 ? (
          <EmptyState
            title={
              status === 'any' && !filters.subject ? t('none') : t('noMatch')
            }
          />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.subject')}</TableHead>
                  <TableHead>{t('columns.record')}</TableHead>
                  <TableHead>{t('columns.reason')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.placed')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {holds.map((hold) => (
                  <TableRow key={hold.id}>
                    <TableCell>{hold.subject}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {hold.recordId ?? (
                        <span className="font-sans text-sm">
                          {t('allRecords')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal break-words">
                      {hold.reason}
                    </TableCell>
                    <TableCell>
                      <Badge variant={hold.active ? 'destructive' : 'outline'}>
                        {t(hold.active ? 'status.active' : 'status.released')}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {format(hold.placedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('open', { subject: hold.subject })}
                          onClick={() => setShown(hold.id)}
                        >
                          <EyeIcon />
                          {t('openButton')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage && <Spinner />}
          {t('more')}
        </Button>
      )}

      <PlaceHoldDialog open={placing} onOpenChange={setPlacing} />
      {shown && (
        <HoldDialog
          key={shown}
          id={shown}
          onOpenChange={(open) => !open && setShown(undefined)}
        />
      )}
    </Page>
  );
}
