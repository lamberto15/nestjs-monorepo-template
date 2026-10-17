import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { buttonVariants } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { LockIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  catalogQuery,
  createRole,
  invalidateAccess,
  updateRole,
  type Role,
  type RoleBody,
} from '@/features/access/api';
import { PermissionEditor } from '@/features/access/permission-editor';
import {
  fromPermissions,
  isValid,
  toPermissions,
  type Catalog,
  type EditorState,
  type Permission,
} from '@/features/access/permissions';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

/** A new role, or an existing one (read-only when built in). */
export function RoleForm(props: { role?: Role }) {
  const catalog = useQuery(catalogQuery);
  if (catalog.isPending) {
    return <Spinner />;
  }
  if (catalog.isError) {
    return <FormAlert message={errorMessage(catalog.error)} />;
  }
  return <RoleFormLoaded catalog={catalog.data} role={props.role} />;
}

function RoleFormLoaded(props: { catalog: Catalog; role?: Role }) {
  const { t } = useTranslation('access');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = useMe()?.can;
  const [error, setError] = useState<string>();
  const readOnly = props.role?.system === true;
  const initial = useMemo(
    () => fromPermissions(props.catalog, props.role?.permissions ?? []),
    [props.catalog, props.role],
  );
  const save = useMutation({
    mutationFn: async (body: RoleBody) => {
      if (props.role) {
        await updateRole(props.role.id, body);
      } else {
        await createRole(body);
      }
    },
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const form = useAppForm({
    defaultValues: {
      name: props.role?.name ?? '',
      description: props.role?.description ?? '',
      permissions: initial.state as EditorState,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('roles.errors.nameRequired'))
          .max(80, t('roles.errors.nameTooLong')),
        description: z.string().max(500, t('roles.errors.descriptionTooLong')),
        permissions: z
          .custom<EditorState>()
          .refine(
            (value) => isValid(props.catalog, value),
            t('roles.errors.params'),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await save.mutateAsync({
          name: value.name.trim(),
          description: value.description,
          permissions: toPermissions(props.catalog, value.permissions),
        });
        toast.success(t(props.role ? 'roles.saved' : 'roles.created'));
        await navigate({ to: '/access/roles' });
      } catch (caught) {
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
        {readOnly && (
          <Alert>
            <LockIcon />
            <AlertDescription>{t('roles.builtIn')}</AlertDescription>
          </Alert>
        )}
        <FormAlert message={error} />
        <form.AppField name="name">
          {(field) => <field.TextField label={t('roles.fields.name')} />}
        </form.AppField>
        <form.AppField name="description">
          {(field) => <field.TextField label={t('roles.fields.description')} />}
        </form.AppField>
        {initial.unknown.length > 0 && (
          <UnknownPermissions
            permissions={initial.unknown}
            readOnly={readOnly}
          />
        )}
        <form.Field name="permissions">
          {(field) => (
            <div className="flex flex-col gap-2">
              <h2 className="text-base font-medium">
                {t('roles.fields.permissions')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('roles.editor.hint')}
              </p>
              <PermissionEditor
                catalog={props.catalog}
                value={field.state.value}
                onChange={field.handleChange}
                disabled={readOnly}
                holds={(key) => can?.[key] === true}
              />
              {field.state.meta.errors.length > 0 && (
                <p role="alert" className="text-sm text-destructive">
                  {t('roles.errors.params')}
                </p>
              )}
            </div>
          )}
        </form.Field>
        <div className="flex gap-2">
          {!readOnly && (
            <form.AppForm>
              <form.SubmitButton>
                {t(props.role ? 'roles.save' : 'roles.create')}
              </form.SubmitButton>
            </form.AppForm>
          )}
          <Link
            to="/access/roles"
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('cancel')}
          </Link>
        </div>
      </FieldGroup>
    </form>
  );
}

/** What the catalog doesn't know: `all.manage` (Administrator), a removed feature's. */
function UnknownPermissions(props: {
  permissions: Permission[];
  readOnly: boolean;
}) {
  const { t } = useTranslation('access');
  return (
    <Alert>
      <AlertDescription>
        <p>{t(props.readOnly ? 'roles.unknownReadOnly' : 'roles.unknown')}</p>
        <ul className="mt-1 list-disc ps-5">
          {props.permissions.map((p, index) => (
            <li key={index}>
              {p.subject === 'all' && p.action === 'manage' ? (
                t('roles.everything')
              ) : (
                <code>
                  {p.subject}.{p.action}
                </code>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
