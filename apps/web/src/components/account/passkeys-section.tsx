import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { KeyRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { api } from '@/lib/api';
import { AUTH_LIMITS } from '@/lib/auth-limits';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/date-time';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  createPasskey,
  isPasskeyCancelled,
  passkeysSupported,
} from '@/lib/passkeys';

export const passkeysQuery = queryOptions({
  queryKey: ['auth', 'passkeys'],
  queryFn: () => unwrap(api.GET('/v1/auth/passkeys')),
});

type Passkey = GetResponse<'/v1/auth/passkeys'>['items'][number];

/**
 * The account's passkeys (docs/auth.md, "Passkeys"): add (the browser's
 * ceremony through @simplewebauthn/browser), rename, remove. Adding and
 * removing want a recent sign-in: the dialog asks when needed.
 */
export function PasskeysSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery(passkeysQuery);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey>();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.DELETE('/v1/auth/passkeys/{id}', { params: { path: { id } } });
    },
    onSuccess: refresh,
  });
  return (
    <Section
      title={t('account.passkeys.title')}
      description={t('account.passkeys.description')}
    >
      {list.isPending ? (
        <Spinner />
      ) : list.data?.items.length ? (
        <ul className="flex flex-col divide-y rounded-md border">
          {list.data.items.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-wrap items-center gap-3 p-3"
            >
              <KeyRoundIcon className="size-4 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{passkey.name}</span>
                <span className="text-xs text-muted-foreground">
                  {passkey.lastUsedAt
                    ? t('account.passkeys.lastUsed', {
                        date: formatDateTime(passkey.lastUsedAt),
                      })
                    : t('account.passkeys.neverUsed')}
                </span>
              </div>
              {passkey.backedUp && (
                <Badge variant="outline">{t('account.passkeys.synced')}</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRenaming(passkey)}
              >
                {t('account.passkeys.rename')}
              </Button>
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('account.passkeys.removeTitle')}
                description={t('account.passkeys.removeDescription', {
                  name: passkey.name,
                })}
                confirm={t('account.passkeys.remove')}
                onConfirm={() => remove.mutateAsync(passkey.id)}
              >
                {t('account.passkeys.remove')}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('account.passkeys.none')}
        </p>
      )}
      {passkeysSupported() ? (
        <Button className="self-start" onClick={() => setAdding(true)}>
          {t('account.passkeys.add')}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('account.passkeys.unsupported')}
        </p>
      )}
      <NameDialog
        open={adding}
        title={t('account.passkeys.add')}
        initial={t('account.passkeys.defaultName')}
        onClose={() => setAdding(false)}
        onSubmit={async (name) => {
          const options = await unwrap(
            api.POST('/v1/auth/passkeys/registration/options'),
          );
          const response = await createPasskey(options);
          await unwrap(
            api.POST('/v1/auth/passkeys', { body: { name, response } }),
          );
          toast.success(t('account.passkeys.added'));
          await refresh();
        }}
      />
      <NameDialog
        open={!!renaming}
        title={t('account.passkeys.rename')}
        initial={renaming?.name ?? ''}
        onClose={() => setRenaming(undefined)}
        onSubmit={async (name) => {
          await unwrap(
            api.PATCH('/v1/auth/passkeys/{id}', {
              params: { path: { id: renaming!.id } },
              body: { name },
            }),
          );
          await refresh();
        }}
      />
    </Section>
  );
}

/** A passkey's name: asked when adding one, and to rename it. */
function NameDialog(props: {
  open: boolean;
  title: string;
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        {props.open && <NameForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function NameForm(props: {
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { name: props.initial },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('auth.fields.nameRequired'))
          .max(
            AUTH_LIMITS.passkeyName,
            t('auth.fields.tooLong', { max: AUTH_LIMITS.passkeyName }),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await props.onSubmit(value.name.trim());
        props.onClose();
      } catch (caught) {
        if (isPasskeyCancelled(caught)) {
          return;
        }
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
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
            <field.TextField label={t('account.passkeys.name')} autoFocus />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton>{t('account.save')}</form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}
