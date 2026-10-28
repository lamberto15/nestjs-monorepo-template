import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import { useInvalidateRecords } from '@/lib/records';
import {
  type Duplicate,
  listDuplicates,
  mergeRecord,
  panelKeys,
  previewMerge,
} from './api';

/** A value as a cell shows it. */
const shown = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

/** What a duplicate is called: the values it matched by. */
const nameOf = (duplicate: Duplicate) =>
  duplicate.matched[0]
    ?.map((field) => shown(duplicate.record[field]))
    .join(' · ') ?? duplicate.id;

/**
 * The record's likely duplicates (the `merge` capability: docs/merging.md),
 * as the API finds them among those the user may read, and with
 * `canMerge` a merge of one into this record: a preview of the fields the
 * user may choose (each kept from this record unless ticked) and what moves,
 * then the merge, which sends the duplicate to the recycle bin.
 */
export function DuplicatesPanel(props: {
  base: string;
  id: string;
  listPath: string;
  canMerge: boolean;
}) {
  const { t } = useTranslation('records');
  const [merging, setMerging] = useState<Duplicate | null>(null);
  const duplicates = useQuery({
    queryKey: panelKeys.duplicates(props.base, props.id),
    queryFn: () => listDuplicates(props.base, props.id),
  });

  if (duplicates.isPending) {
    return <Skeleton className="h-16 w-full" aria-busy />;
  }
  if (duplicates.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('duplicates.error')}
      </p>
    );
  }
  if (duplicates.data.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('duplicates.empty')}</p>
    );
  }
  return (
    <>
      <ul className="flex flex-col divide-y rounded-md border">
        {duplicates.data.items.map((duplicate) => (
          <li
            key={duplicate.id}
            className="flex items-center justify-between gap-2 p-2 text-sm"
          >
            <span>
              {nameOf(duplicate)}
              <span className="ms-2 text-muted-foreground">
                {t('duplicates.matched', {
                  fields: duplicate.matched
                    .map((rule) => rule.join(' + '))
                    .join(', '),
                })}
              </span>
            </span>
            {props.canMerge && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMerging(duplicate)}
              >
                {t('duplicates.merge')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {merging && (
        <MergeDialog
          {...props}
          duplicate={merging}
          onClose={() => setMerging(null)}
        />
      )}
    </>
  );
}

function MergeDialog(props: {
  base: string;
  id: string;
  listPath: string;
  duplicate: Duplicate;
  onClose: () => void;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRecords(props.listPath);
  // The fields that take the duplicate's value; every other keeps this record's.
  const [taken, setTaken] = useState<string[]>([]);
  const body = {
    duplicateId: props.duplicate.id,
    fields: Object.fromEntries(
      taken.map((field) => [field, 'duplicate' as const]),
    ),
  };
  const preview = useQuery({
    queryKey: [
      ...panelKeys.duplicates(props.base, props.id),
      'preview',
      props.duplicate.id,
    ],
    queryFn: () => previewMerge(props.base, props.id, body),
  });
  const merge = useMutation({
    mutationFn: () => mergeRecord(props.base, props.id, body),
    onSuccess: async () => {
      toast.success(t('duplicates.merged'));
      props.onClose();
      await queryClient.invalidateQueries({
        queryKey: panelKeys.all(props.base, props.id),
      });
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const differing = preview.data?.fields.filter((field) => field.differs) ?? [];
  const moves = preview.data?.moves;

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('duplicates.title')}</DialogTitle>
          <DialogDescription>
            {t('duplicates.description', { name: nameOf(props.duplicate) })}
          </DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy />
        ) : preview.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(preview.error)}
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {differing.length === 0 ? (
              <p className="text-muted-foreground">{t('duplicates.same')}</p>
            ) : (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">
                  {t('duplicates.choose')}
                </legend>
                {differing.map((field) => (
                  <label key={field.name} className="flex items-start gap-2">
                    <Checkbox
                      checked={taken.includes(field.name)}
                      onCheckedChange={(checked) =>
                        setTaken((fields) =>
                          checked
                            ? [...fields, field.name]
                            : fields.filter((name) => name !== field.name),
                        )
                      }
                    />
                    <span>
                      {t('duplicates.take', {
                        field: field.name,
                        value: shown(field.duplicate),
                        current: shown(field.survivor),
                      })}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {moves && (
              <p className="text-muted-foreground">
                {t('duplicates.moves', {
                  tags: moves.tags,
                  comments: moves.comments,
                  attachments: moves.attachments,
                  references: moves.references.reduce(
                    (sum, reference) => sum + reference.count,
                    0,
                  ),
                })}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={!preview.isSuccess || merge.isPending}
            onClick={() => merge.mutate()}
          >
            {merge.isPending && <Spinner />}
            {t('duplicates.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
