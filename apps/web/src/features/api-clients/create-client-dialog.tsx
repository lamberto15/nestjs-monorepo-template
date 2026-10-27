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
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rolesQuery } from '@/features/access/api';
import {
  endInPast,
  grantsBody,
  type GrantDraft,
} from '@/features/access/grants';
import { RoleGrantsPicker } from '@/features/access/pickers';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, resetOnClose, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import { API_CLIENT_LIMITS, type CreateClientBody } from './queries';

/**
 * Name, an optional daily quota and roles (on top of what every client may
 * do, each until a date if wanted); `onCreate` makes the client with all of
 * them in one call.
 */
export function CreateClientDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateClientBody) => Promise<unknown>;
}) {
  const { t } = useTranslation('api-clients');
  const [error, setError] = useState<string>();
  const roles = useQuery({ ...rolesQuery, enabled: props.open });
  const [grants, setGrants] = useState<GrantDraft>({});
  const pastEnd = Object.values(grants).some((until) => endInPast(until));
  const form = useAppForm({
    defaultValues: { name: '', dailyQuota: '' },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('create.nameRequired'))
          .max(
            API_CLIENT_LIMITS.name,
            t('create.nameTooLong', { max: API_CLIENT_LIMITS.name }),
          ),
        dailyQuota: z
          .string()
          .trim()
          .refine((value) => value === '' || /^[1-9]\d{0,8}$/.test(value), {
            message: t('create.quotaInvalid'),
          }),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      if (pastEnd) return;
      const { roleIds, roleExpiresAt } = grantsBody(grants);
      try {
        await props.onCreate({
          name: value.name.trim(),
          ...(value.dailyQuota.trim() && {
            dailyQuota: Number(value.dailyQuota),
          }),
          ...(roleIds.length > 0 && { roleIds }),
          ...(Object.keys(roleExpiresAt).length > 0 && { roleExpiresAt }),
        });
        form.reset();
        setGrants({});
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  const onOpenChange = resetOnClose(props.onOpenChange, () => {
    form.reset();
    setError(undefined);
  });
  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>{t('create.description')}</DialogDescription>
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
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={t('create.name')}
                  placeholder={t('create.namePlaceholder')}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="dailyQuota">
              {(field) => (
                <field.TextField
                  label={t('create.quota')}
                  description={t('create.quotaHint')}
                />
              )}
            </form.AppField>
            {roles.isPending ? (
              <Spinner />
            ) : roles.isError ? (
              <FormAlert message={errorMessage(roles.error)} />
            ) : (
              roles.data.length > 0 && (
                <RoleGrantsPicker
                  idPrefix="client"
                  roles={roles.data}
                  value={grants}
                  onChange={setGrants}
                />
              )
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('create.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>{t('create.submit')}</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
