import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import type { TFunction } from 'i18next';
import {
  type AccessImpact,
  createUnit,
  invalidateAccess,
  previewUnitChange,
  type Unit,
  UNIT_LIMITS,
  type UnitType,
  updateUnit,
} from '@/features/access/api';
import { ImpactSummary } from '@/features/access/access-impact';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { orderedTree } from '@/features/access/pickers';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

const TOP = '-';

type Body = { type: UnitType; name: string; parentId: string | null };

const UNIT_TYPES = ['division', 'department', 'team'] as const;

/** The 409s of the unit routes as readable messages; any other error as it comes. */
export function unitErrorMessage(error: unknown, t: TFunction) {
  if (isApiError(error)) {
    switch (error.code) {
      case 'unit_name_taken':
        return t('units.errors.nameTaken');
      case 'unit_not_empty':
        return t('units.errors.notEmpty');
      case 'unit_managed_by_scim':
        return t('units.errors.managedByScim');
    }
  }
  return errorMessage(error);
}

/** The units a unit may move under: not itself, nor any unit below it. */
export function parentChoices(units: readonly Unit[], unit?: Unit): Unit[] {
  if (!unit) return orderedTree(units);
  const below = new Set<string>([unit.id]);
  // Tree order puts every unit after its parent: one pass collects them.
  for (const candidate of orderedTree(units)) {
    if (candidate.parentId && below.has(candidate.parentId)) {
      below.add(candidate.id);
    }
  }
  return orderedTree(units).filter((t) => !below.has(t.id));
}

/** Create a unit, or rename / move one (`/v1/access/organizational-units`, Access.manageOrganizationalUnits). */
export function UnitDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  units: Unit[];
  unit?: Unit;
}) {
  const { t } = useTranslation('access');
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(props.unit ? 'units.editTitle' : 'units.newTitle')}
          </DialogTitle>
          <DialogDescription>{t('units.dialogDescription')}</DialogDescription>
        </DialogHeader>
        {props.open && (
          <UnitForm
            units={props.units}
            unit={props.unit}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function UnitForm(props: { units: Unit[]; unit?: Unit; onDone: () => void }) {
  const { t } = useTranslation('access');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  // A move waiting for its confirmation, with what it would change of who sees what.
  const [moving, setMoving] = useState<{ body: Body; impact: AccessImpact }>();
  const save = useMutation({
    mutationFn: (body: Body) =>
      props.unit ? updateUnit(props.unit.id, body) : createUnit(body),
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const submit = async (body: Body) => {
    try {
      await save.mutateAsync(body);
      toast.success(t(props.unit ? 'units.saved' : 'units.created'));
      props.onDone();
    } catch (caught) {
      if (!applyFieldErrors(form, caught)) {
        setError(unitErrorMessage(caught, t));
      }
    }
  };
  const form = useAppForm({
    defaultValues: {
      type: props.unit?.type ?? ('team' as UnitType),
      name: props.unit?.name ?? '',
      parentId: props.unit?.parentId ?? TOP,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('units.errors.nameRequired'))
          .max(
            UNIT_LIMITS.name,
            t('units.errors.nameTooLong', { max: UNIT_LIMITS.name }),
          ),
        type: z.enum(UNIT_TYPES),
        parentId: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const body = {
        type: value.type,
        name: value.name.trim(),
        parentId: value.parentId === TOP ? null : value.parentId,
      };
      if (props.unit && body.parentId !== props.unit.parentId) {
        // A move: first what it would change (a dry run), then the confirmation.
        try {
          setMoving({
            body,
            impact: await previewUnitChange(props.unit.id, body),
          });
        } catch (caught) {
          if (!applyFieldErrors(form, caught)) {
            setError(unitErrorMessage(caught, t));
          }
        }
        return;
      }
      await submit(body);
    },
  });
  const options = [
    { value: TOP, label: t('units.topLevel') },
    ...parentChoices(props.units, props.unit).map((unit) => ({
      value: unit.id,
      label: `${'— '.repeat(unit.depth)}${unit.name}`,
    })),
  ];
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        <form.AppField name="name">
          {(field) => (
            <field.TextField label={t('units.fields.name')} autoFocus />
          )}
        </form.AppField>
        <form.AppField name="type">
          {(field) => (
            <field.SelectField
              label={t('units.fields.type')}
              options={UNIT_TYPES.map((type) => ({
                value: type,
                label: t(`units.types.${type}`),
              }))}
            />
          )}
        </form.AppField>
        <form.AppField name="parentId">
          {(field) => (
            <field.SelectField
              label={t('units.fields.parent')}
              options={options}
            />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton className="self-start">
            {t(props.unit ? 'units.save' : 'units.create')}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
      <ConfirmDialog
        open={moving !== undefined}
        onOpenChange={(open) => !open && setMoving(undefined)}
        title={t('units.impact.moveTitle', { unit: props.unit?.name })}
        description={
          moving && (
            <ImpactSummary impact={moving.impact} units={props.units} t={t} />
          )
        }
        confirm={t('units.impact.moveConfirm')}
        onConfirm={() => submit(moving!.body)}
      />
    </form>
  );
}
