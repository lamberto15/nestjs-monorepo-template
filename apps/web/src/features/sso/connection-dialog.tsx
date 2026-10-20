import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  useCreateConnection,
  useUpdateConnection,
  type Connection,
  type ConnectionChanges,
  type CreateConnectionBody,
} from './queries';

/** Whether the text is an absolute https or http URL. */
function isUrl(value: string) {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Add a connection (OIDC or SAML), or change one (docs/auth.md, "Enterprise
 * SSO"). A new connection starts off unless switched on here. The OIDC client
 * secret and the SAML certificates are never answered: left empty when
 * editing they stay as they are. The protocol of a connection can't change.
 */
export function ConnectionDialog(props: {
  /** The connection to change; none: a new one. */
  connection?: Connection;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('sso');
  const { connection } = props;
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const [error, setError] = useState<string>();

  const form = useAppForm({
    defaultValues: {
      protocol: connection?.protocol ?? 'oidc',
      name: connection?.name ?? '',
      enabled: connection?.enabled ?? false,
      jitProvisioning: connection?.jitProvisioning ?? false,
      issuer: connection?.oidc?.issuer ?? '',
      clientId: connection?.oidc?.clientId ?? '',
      clientSecret: '',
      idpEntityId: connection?.saml?.idpEntityId ?? '',
      idpSsoUrl: connection?.saml?.idpSsoUrl ?? '',
      certificate: '',
      nextCertificate: '',
      allowIdpInitiated: connection?.saml?.allowIdpInitiated ?? false,
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const name = value.name.trim();
      const certificates = [value.certificate, value.nextCertificate]
        .map((pem) => pem.trim())
        .filter(Boolean);
      try {
        if (connection) {
          const changes: ConnectionChanges = {
            name,
            enabled: value.enabled,
            jitProvisioning: value.jitProvisioning,
          };
          if (connection.protocol === 'oidc') {
            changes.issuer = value.issuer.trim();
            changes.clientId = value.clientId.trim();
            if (value.clientSecret) changes.clientSecret = value.clientSecret;
          } else {
            changes.idpEntityId = value.idpEntityId.trim();
            changes.idpSsoUrl = value.idpSsoUrl.trim();
            changes.allowIdpInitiated = value.allowIdpInitiated;
            if (certificates.length > 0) changes.idpCertificates = certificates;
          }
          await update.mutateAsync({ id: connection.id, changes });
          toast.success(t('connections.updated', { name }));
        } else {
          const common = {
            name,
            enabled: value.enabled,
            jitProvisioning: value.jitProvisioning,
          };
          const body: CreateConnectionBody =
            value.protocol === 'oidc'
              ? {
                  ...common,
                  protocol: 'oidc',
                  issuer: value.issuer.trim(),
                  clientId: value.clientId.trim(),
                  clientSecret: value.clientSecret,
                }
              : {
                  ...common,
                  protocol: 'saml',
                  idpEntityId: value.idpEntityId.trim(),
                  idpSsoUrl: value.idpSsoUrl.trim(),
                  idpCertificates: certificates,
                  allowIdpInitiated: value.allowIdpInitiated,
                };
          await create.mutateAsync(body);
          toast.success(t('connections.created', { name }));
        }
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
  const url = (missing: string) => ({
    onSubmit: ({ value }: { value: string }) =>
      isUrl(value.trim()) ? undefined : { message: missing },
  });
  const switchField = (
    name: 'enabled' | 'jitProvisioning' | 'allowIdpInitiated',
    label: string,
    description: string,
  ) => (
    <form.Field name={name}>
      {(f) => (
        <Field orientation="horizontal">
          <Switch
            id={`field-${name}`}
            checked={f.state.value}
            onCheckedChange={f.handleChange}
          />
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor={`field-${name}`}>{label}</FieldLabel>
            <FieldDescription>{description}</FieldDescription>
          </div>
        </Field>
      )}
    </form.Field>
  );

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {connection
              ? t('form.editTitle', { name: connection.name })
              : t('form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('form.description')}</DialogDescription>
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
            {!connection && (
              <form.AppField name="protocol">
                {(f) => (
                  <f.SelectField
                    label={t('form.protocol')}
                    options={[
                      { value: 'oidc', label: t('protocol.oidc') },
                      { value: 'saml', label: t('protocol.saml') },
                    ]}
                  />
                )}
              </form.AppField>
            )}
            <form.AppField
              name="name"
              validators={required(t('form.nameRequired'))}
            >
              {(f) => <f.TextField label={t('form.name')} autoFocus />}
            </form.AppField>

            <form.Subscribe selector={(state) => state.values.protocol}>
              {(protocol) =>
                protocol === 'oidc' ? (
                  <>
                    <form.AppField
                      name="issuer"
                      validators={url(t('form.urlInvalid'))}
                    >
                      {(f) => (
                        <f.TextField
                          label={t('form.issuer')}
                          description={t('form.issuerHint')}
                          placeholder="https://login.example.com"
                        />
                      )}
                    </form.AppField>
                    <form.AppField
                      name="clientId"
                      validators={required(t('form.required'))}
                    >
                      {(f) => <f.TextField label={t('form.clientId')} />}
                    </form.AppField>
                    <form.AppField
                      name="clientSecret"
                      validators={
                        connection ? undefined : required(t('form.required'))
                      }
                    >
                      {(f) => (
                        <f.TextField
                          label={t('form.clientSecret')}
                          type="password"
                          autoComplete="off"
                          description={
                            connection
                              ? t('form.secretKeep')
                              : t('form.secretHint')
                          }
                        />
                      )}
                    </form.AppField>
                  </>
                ) : (
                  <>
                    <form.AppField
                      name="idpEntityId"
                      validators={required(t('form.required'))}
                    >
                      {(f) => (
                        <f.TextField
                          label={t('form.idpEntityId')}
                          description={t('form.idpEntityIdHint')}
                        />
                      )}
                    </form.AppField>
                    <form.AppField
                      name="idpSsoUrl"
                      validators={url(t('form.urlInvalid'))}
                    >
                      {(f) => (
                        <f.TextField
                          label={t('form.idpSsoUrl')}
                          description={t('form.idpSsoUrlHint')}
                        />
                      )}
                    </form.AppField>
                    <form.AppField
                      name="certificate"
                      validators={
                        connection ? undefined : required(t('form.required'))
                      }
                    >
                      {(f) => (
                        <f.TextAreaField
                          label={t('form.certificate')}
                          description={
                            connection
                              ? t('form.certificateKeep')
                              : t('form.certificateHint')
                          }
                          rows={5}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="nextCertificate">
                      {(f) => (
                        <f.TextAreaField
                          label={t('form.nextCertificate')}
                          description={t('form.nextCertificateHint')}
                          rows={4}
                        />
                      )}
                    </form.AppField>
                    {switchField(
                      'allowIdpInitiated',
                      t('form.allowIdpInitiated'),
                      t('form.allowIdpInitiatedHint'),
                    )}
                  </>
                )
              }
            </form.Subscribe>

            {switchField('jitProvisioning', t('form.jit'), t('form.jitHint'))}
            {switchField('enabled', t('form.enabled'), t('form.enabledHint'))}
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
