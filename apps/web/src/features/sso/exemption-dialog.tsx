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
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { useAddExemption } from './queries';

/**
 * The members that can be exempted, by address: the first 100 of the
 * members' list (the list's maximum page). The API decides who may be
 * (an active member; an administrator with two-factor when it is on).
 */
const membersQuery = {
  queryKey: ['sso', 'exemption-candidates'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/access/users', {
        params: { query: { page: 1, limit: 100, sort: 'email' } },
      }),
    ),
} as const;

/** Exempt a member from "SSO required" (docs/auth.md, "SSO required"). */
export function ExemptionDialog(props: {
  /** Members already exempted: not offered again. */
  exempted: string[];
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('sso');
  const members = useQuery({ ...membersQuery, meta: { errorToast: false } });
  const add = useAddExemption();
  const [error, setError] = useState<string>();

  const options = (members.data?.items ?? [])
    .filter((member) => member.active && !props.exempted.includes(member.id))
    .map((member) => ({
      value: member.id,
      label: member.name ? `${member.name} (${member.email})` : member.email,
    }));

  const form = useAppForm({
    defaultValues: { userId: '', reason: '' },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await add.mutateAsync({
          userId: value.userId,
          reason: value.reason.trim(),
        });
        const name =
          options.find((option) => option.value === value.userId)?.label ?? '';
        toast.success(t('exemption.added', { name }));
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  const required = (message: string) => ({
    onSubmit: ({ value }: { value: string }) =>
      value.trim() ? undefined : { message },
  });

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('exemption.title')}</DialogTitle>
          <DialogDescription>{t('exemption.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert
              message={members.isError ? errorMessage(members.error) : error}
            />
            <form.AppField
              name="userId"
              validators={required(t('exemption.memberRequired'))}
            >
              {(f) => (
                <f.SelectField
                  label={t('exemption.member')}
                  options={options}
                  placeholder={t('exemption.memberPlaceholder')}
                />
              )}
            </form.AppField>
            <form.AppField
              name="reason"
              validators={required(t('exemption.reasonRequired'))}
            >
              {(f) => (
                <f.TextField
                  label={t('exemption.reason')}
                  description={t('exemption.reasonHint')}
                />
              )}
            </form.AppField>
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
              <form.SubmitButton>{t('exemption.save')}</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
