import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { MoveRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { changeField, withConditions, withFields } from './api';
import { RecordSummary, titleOf, useRecordRows, type ViewProps } from './rows';
import { fetchPage } from '@/lib/list-query';
import {
  listFilters,
  DEFAULT_PER_PAGE,
  type ListPageData,
} from '@/lib/list-query';
import { recordKeys, useInvalidateRecords, useRecordCan } from '@/lib/records';

type Item = { id: string; can?: { update?: boolean } } & Record<
  string,
  unknown
>;
type Page = ListPageData<Item>;

/**
 * Records in a column per value of an enum field (`views.board`). Each column
 * is its own query of the list (the table's filters and search, and the
 * field equal to the column's value), paged by "Load more". A card moves to
 * another column from its menu, which a keyboard reaches: the record is
 * changed through its update route (ETag, permissions and validations as
 * the form's); the card moves at once and goes back, with a message, if
 * the update is refused or does not change the field.
 */
export function Board(
  props: ViewProps & { subject: string; field: string; readOnly: boolean },
) {
  const { path, pathParams, description, extra, params, field } = props;
  const { t } = useTranslation('record-views');
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRecords(path);
  const canOf = useRecordCan(props.subject);
  const options =
    description.fields.find((f) => f.name === field)?.options ?? [];
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const size = (value: string) => sizes[value] ?? DEFAULT_PER_PAGE;

  const fields = withFields(params, [field], description);
  const queryFor = (value: string) => {
    const query = {
      ...extra,
      ...withConditions(listFilters(params), [{ field, op: 'eq', value }]),
      ...(params.sort && { sort: params.sort }),
      fields,
      page: '1',
      limit: String(size(value)),
      count: 'true',
    };
    return {
      queryKey: [...recordKeys.lists(path), 'board', value, query] as const,
      query,
    };
  };
  const results = useQueries({
    queries: options.map((value) => {
      const { queryKey, query } = queryFor(value);
      return {
        queryKey,
        queryFn: () =>
          fetchPage(path as never, query, pathParams) as Promise<Page>,
      };
    }),
  });

  const columns = options.map((value, index) => ({
    value,
    result: results[index],
    items: results[index]?.data?.items ?? [],
  }));
  const rows = useRecordRows(
    columns.flatMap((column) => column.items),
    props.columns,
    props.visibility,
  );
  const rowOf = new Map(rows.map((row) => [row.id, row]));

  const move = useMutation({
    mutationFn: async (move: { item: Item; from: string; to: string }) => {
      const applied = await changeField(path, move.item.id, field, move.to);
      if (!applied) toast.error(t('board.notApplied'));
      return applied;
    },
    onMutate: async ({ item, from, to }) => {
      await queryClient.cancelQueries({ queryKey: recordKeys.lists(path) });
      const keys = { from: queryFor(from).queryKey, to: queryFor(to).queryKey };
      const before = {
        from: queryClient.getQueryData<Page>(keys.from),
        to: queryClient.getQueryData<Page>(keys.to),
      };
      queryClient.setQueryData<Page>(
        keys.from,
        (page) =>
          page && {
            ...page,
            items: page.items.filter((i) => i.id !== item.id),
            ...(page.total !== undefined && { total: page.total - 1 }),
          },
      );
      queryClient.setQueryData<Page>(
        keys.to,
        (page) =>
          page && {
            ...page,
            items: [{ ...item, [field]: to }, ...page.items],
            ...(page.total !== undefined && { total: page.total + 1 }),
          },
      );
      return { keys, before };
    },
    // Back where it was: a refusal (the global handler says why), or an
    // update that did not change the field.
    onSettled: (applied, error, _move, context) => {
      if (context && (error || !applied)) {
        queryClient.setQueryData(context.keys.from, context.before.from);
        queryClient.setQueryData(context.keys.to, context.before.to);
      }
      void invalidate();
    },
  });

  return (
    <div className="flex gap-3 overflow-x-auto pb-2" data-slot="record-board">
      {columns.map(({ value, result, items }) => {
        const total = result?.data?.total ?? items.length;
        const heading = `board-${value}`;
        return (
          <section
            key={value}
            aria-labelledby={heading}
            aria-busy={result?.isFetching}
            className="flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/40 p-2"
          >
            <h3 id={heading} className="px-1 text-sm font-medium">
              {value}{' '}
              <span className="font-normal text-muted-foreground">{total}</span>
            </h3>
            {result?.isError ? (
              <p role="alert" className="px-1 text-sm text-destructive">
                {t('board.failed')}
              </p>
            ) : items.length === 0 && !result?.isPending ? (
              <p className="px-1 text-sm text-muted-foreground">
                {t('board.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => {
                  const row = rowOf.get(item.id);
                  const movable =
                    !props.readOnly &&
                    !props.paused &&
                    canOf(item).update &&
                    !move.isPending;
                  return (
                    <li
                      key={item.id}
                      className="flex items-start gap-1 rounded-md border bg-card p-2 text-card-foreground"
                    >
                      <div className="min-w-0 flex-1">
                        {row && (
                          <RecordSummary
                            row={row}
                            href={props.rowHref?.(item as never)}
                          />
                        )}
                      </div>
                      {movable && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('board.moveCard', {
                                  title: row ? titleOf(row) : item.id,
                                })}
                                className="pointer-coarse:size-10"
                              />
                            }
                          >
                            <MoveRightIcon aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {options
                              .filter((option) => option !== value)
                              .map((option) => (
                                <DropdownMenuItem
                                  key={option}
                                  onClick={() =>
                                    move.mutate({
                                      item,
                                      from: value,
                                      to: option,
                                    })
                                  }
                                >
                                  {t('board.moveTo', { column: option })}
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {items.length < total && (
              <Button
                variant="outline"
                size="sm"
                disabled={
                  result?.isFetching ||
                  size(value) >= description.limits.maxLimit
                }
                onClick={() =>
                  setSizes((s) => ({
                    ...s,
                    [value]: Math.min(
                      size(value) + DEFAULT_PER_PAGE,
                      description.limits.maxLimit,
                    ),
                  }))
                }
              >
                {t('board.more', { shown: items.length, total })}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}
