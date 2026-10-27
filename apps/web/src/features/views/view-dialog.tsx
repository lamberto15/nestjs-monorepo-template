import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { useCan } from '@/lib/features';
import { unitOptions, unitRefsQuery } from '@/lib/list-refs';
import { z } from '@/lib/zod';
import {
  useCreateView,
  useUpdateView,
  type NewView,
  type SavedView,
} from './api';

/** The schema's limit (`POST /v1/views`). */
const NAME_MAX = 200;

type Visibility = SavedView['visibility'];

/**
 * Save the list as it is shown (`current`: its query and columns) under a
 * name, or, with `view`, rename that view. A name another view of the list
 * has in the same place is a 409 shown on the name field; any other refusal
 * (a filter on a field the user may not read: 403 `field_forbidden`) is the
 * dialog's alert.
 */
export function ViewDialog(props: {
  subject: string;
  /** What to save: the list's current query and columns. */
  current?: Pick<NewView, 'query' | 'columns'>;
  /** The view to rename (then `current` is not used). */
  view?: SavedView;
  onSaved: (view: SavedView) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('views');
  const { view } = props;
  const create = useCreateView();
  const update = useUpdateView();
  const canShareTenant = useCan('Access.manageViews');
  const units = useQuery(unitRefsQuery);
  const [error, setError] = useState<string>();

  const visibilities: Visibility[] = canShareTenant
    ? ['private', 'unit', 'tenant']
    : ['private', 'unit'];

  const form = useAppForm({
    defaultValues: {
      name: view?.name ?? '',
      visibility: 'private' as Visibility,
      unitId: '',
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const name = value.name.trim();
      try {
        let saved: SavedView;
        if (view) {
          saved =
            name === view.name
              ? view
              : await update.mutateAsync({
                  id: view.id,
                  changes: { name },
                });
          toast.success(t('renamed', { name }));
        } else {
          saved = await create.mutateAsync({
            subject: props.subject,
            name,
            visibility: value.visibility,
            ...(value.visibility === 'unit' && { unitId: value.unitId }),
            ...props.current,
          });
          toast.success(t('saved', { name }));
        }
        props.onSaved(saved);
        props.onOpenChange(false);
      } catch (caught) {
        if (isApiError(caught) && caught.status === 409) {
          form.setFieldMeta('name', (meta) => ({
            ...meta,
            isTouched: true,
            errorMap: {
              ...meta?.errorMap,
              onSubmit: { message: t('form.nameTaken', { name }) },
            },
          }));
        } else if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {view
              ? t('form.renameTitle', { name: view.name })
              : t('form.saveTitle')}
          </DialogTitle>
          {!view && (
            <DialogDescription>{t('form.saveDescription')}</DialogDescription>
          )}
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            <form.AppField
              name="name"
              validators={{
                onSubmit: z
                  .string()
                  .trim()
                  .min(1, t('form.nameRequired'))
                  .max(NAME_MAX, t('form.nameTooLong')),
              }}
            >
              {(f) => <f.TextField label={t('form.name')} autoFocus />}
            </form.AppField>
            {!view && (
              <>
                <form.AppField name="visibility">
                  {(f) => (
                    <f.SelectField
                      label={t('form.visibility')}
                      options={visibilities.map((value) => ({
                        value,
                        label: t(`visibility.${value}`),
                      }))}
                    />
                  )}
                </form.AppField>
                <form.Subscribe selector={(state) => state.values.visibility}>
                  {(visibility) =>
                    visibility === 'unit' && (
                      <form.AppField
                        name="unitId"
                        validators={{
                          onSubmit: z.string().min(1, t('form.unitRequired')),
                        }}
                      >
                        {(f) => (
                          <f.SelectField
                            label={t('form.unit')}
                            placeholder={t('form.unitPlaceholder')}
                            options={unitOptions(units.data ?? [])}
                          />
                        )}
                      </form.AppField>
                    )
                  }
                </form.Subscribe>
              </>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              {t('form.cancel')}
            </Button>
            <form.AppForm>
              <form.SubmitButton>{t('form.save')}</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
