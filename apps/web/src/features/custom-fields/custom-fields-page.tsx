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
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
} from '@nestjs-monorepo-template/ui/components/sortable';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { allCustomFieldsQuery, type CustomField } from '@/lib/custom-fields';
import { errorMessage } from '@/lib/errors';
import {
  CUSTOM_FIELD_SUBJECTS,
  useDeactivateField,
  useReorderFields,
  useUpdateField,
} from './api';
import { FieldDialog } from './field-dialog';

/**
 * The custom fields of one subject (docs/custom-fields.md): the active ones
 * in their order (drag the handle, or Space and the arrow keys on it, or
 * the move buttons), the deactivated ones below. Nothing is deleted:
 * deactivating keeps the stored values and the key, and a field can be
 * brought back.
 */
export function CustomFieldsPage() {
  const { t } = useTranslation('custom-fields');
  const [subject, setSubject] = useState<string>(CUSTOM_FIELD_SUBJECTS[0]);
  const fields = useQuery({
    ...allCustomFieldsQuery(subject),
    meta: { errorToast: false },
  });
  const reorder = useReorderFields(subject);
  const update = useUpdateField(subject);
  const deactivate = useDeactivateField(subject);
  // `null`: closed; `'new'`: a new field; a field: its edit.
  const [editing, setEditing] = useState<CustomField | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<CustomField>();

  const active = (fields.data ?? []).filter((f) => f.active);
  const inactive = (fields.data ?? []).filter((f) => !f.active);

  const move = (field: CustomField, by: -1 | 1) => {
    const ids = active.map((f) => f.id);
    const from = ids.indexOf(field.id);
    const to = from + by;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    reorder.mutate(ids);
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-medium">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <PlusIcon />
          {t('add')}
        </Button>
      </div>
      <Field className="max-w-xs">
        <FieldLabel htmlFor="custom-fields-subject">{t('subject')}</FieldLabel>
        <Select
          items={CUSTOM_FIELD_SUBJECTS.map((s) => ({
            value: s,
            label: t(`subjects.${s}`, { defaultValue: s }),
          }))}
          value={subject}
          onValueChange={(next) => next && setSubject(next)}
        >
          <SelectTrigger id="custom-fields-subject" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CUSTOM_FIELD_SUBJECTS.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`subjects.${s}`, { defaultValue: s })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {fields.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {fields.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(fields.error)}
        </p>
      )}
      {fields.isSuccess && (
        <>
          {active.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('none')}
            </p>
          ) : (
            <section
              aria-labelledby="cf-active"
              className="flex flex-col gap-2"
            >
              <h2 id="cf-active" className="text-sm font-medium">
                {t('active', { n: active.length })}
              </h2>
              <p className="text-xs text-muted-foreground">{t('orderHint')}</p>
              <Sortable
                value={active}
                getItemValue={(f) => f.id}
                onValueChange={(next) => reorder.mutate(next.map((f) => f.id))}
              >
                <SortableContent
                  render={
                    <div
                      role="list"
                      aria-labelledby="cf-active"
                      className="flex flex-col gap-2"
                    />
                  }
                >
                  {active.map((field, index) => (
                    <SortableItem
                      key={field.id}
                      value={field.id}
                      render={
                        <div
                          role="listitem"
                          className="flex items-center gap-3 rounded-md border bg-card p-3"
                        />
                      }
                    >
                      <SortableItemHandle
                        aria-label={t('reorder', { label: field.label })}
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                          />
                        }
                      >
                        <GripVerticalIcon />
                      </SortableItemHandle>
                      <FieldSummary field={field} />
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('moveUp', { label: field.label })}
                          disabled={index === 0}
                          onClick={() => move(field, -1)}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('moveDown', { label: field.label })}
                          disabled={index === active.length - 1}
                          onClick={() => move(field, 1)}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('edit', { label: field.label })}
                          onClick={() => setEditing(field)}
                        >
                          {t('editButton')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('deactivate', { label: field.label })}
                          onClick={() => setDeactivating(field)}
                        >
                          {t('deactivateButton')}
                        </Button>
                      </div>
                    </SortableItem>
                  ))}
                </SortableContent>
              </Sortable>
            </section>
          )}

          {inactive.length > 0 && (
            <section
              aria-labelledby="cf-inactive"
              className="flex flex-col gap-2"
            >
              <h2 id="cf-inactive" className="text-sm font-medium">
                {t('inactive', { n: inactive.length })}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('inactiveHint')}
              </p>
              <ul className="flex flex-col gap-2">
                {inactive.map((field) => (
                  <li
                    key={field.id}
                    className="flex items-center gap-3 rounded-md border bg-muted/40 p-3"
                  >
                    <FieldSummary field={field} />
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('reactivate', { label: field.label })}
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate(
                            { id: field.id, changes: { active: true } },
                            {
                              onSuccess: () => toast.success(t('reactivated')),
                              onError: (error) =>
                                toast.error(errorMessage(error)),
                            },
                          )
                        }
                      >
                        {t('reactivateButton')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {editing && (
        <FieldDialog
          // A fresh form for each field (or a new one).
          key={editing === 'new' ? 'new' : editing.id}
          subject={subject}
          field={editing === 'new' ? undefined : editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deactivating}
        onOpenChange={(open) => !open && setDeactivating(undefined)}
        title={t('deactivateTitle', { label: deactivating?.label })}
        description={t('deactivateDescription', { key: deactivating?.key })}
        confirm={t('deactivateConfirm')}
        onConfirm={async () => {
          if (deactivating) await deactivate.mutateAsync(deactivating.id);
          toast.success(t('deactivated'));
        }}
      />
    </div>
  );
}

function FieldSummary(props: { field: CustomField }) {
  const { t } = useTranslation('custom-fields');
  const { field } = props;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-words">{field.label}</span>
        <code className="text-xs text-muted-foreground">{field.key}</code>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="secondary">{t(`types.${field.type}`)}</Badge>
        {field.required && (
          <Badge variant="outline">{t('badges.required')}</Badge>
        )}
        {field.filterable && (
          <Badge variant="outline">{t('badges.filterable')}</Badge>
        )}
        {field.sortable && (
          <Badge variant="outline">{t('badges.sortable')}</Badge>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}
