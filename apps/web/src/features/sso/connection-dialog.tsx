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
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputLabel,
  TagsInputList,
} from '@nestjs-monorepo-template/ui/components/tags-input';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { CopyValue } from './copy-value';
import {
  AUTH_METHODS,
  MAPPING_ERROR_FIELDS,
  mappingOf,
  presetValues,
  valuesOf,
  type EmailTrust,
  type OAuth2Values,
  type PresetChoice,
} from './oauth2';
import {
  useCreateConnection,
  useImportSamlMetadata,
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
 * Add a connection (OIDC, SAML or OAuth 2.0), or change one (docs/auth.md, "Enterprise
 * SSO"). A new connection starts off unless switched on here. The OIDC client
 * secret (OAuth 2.0 too) and the SAML certificates are never answered: left empty when
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
  const importMetadata = useImportSamlMetadata();
  const [metadataUrl, setMetadataUrl] = useState('');
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
      ...valuesOf(connection),
      // The OAuth 2.0 client id is the OIDC one's field.
      ...(connection?.oauth2 ? { clientId: connection.oauth2.clientId } : {}),
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
          } else if (connection.protocol === 'oauth2') {
            changes.clientId = value.clientId.trim();
            if (value.clientSecret) changes.clientSecret = value.clientSecret;
            changes.authorizationEndpoint = value.authorizationEndpoint.trim();
            changes.tokenEndpoint = value.tokenEndpoint.trim();
            changes.userinfoEndpoint = value.userinfoEndpoint.trim();
            changes.tokenEndpointAuthMethod = value.tokenEndpointAuthMethod;
            changes.scopes = value.scopes;
            changes.mapping = mappingOf(value);
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
              : value.protocol === 'oauth2'
                ? {
                    ...common,
                    protocol: 'oauth2',
                    // The preset names the provider; the fields (which it
                    // filled and the administrator may have edited) override it.
                    ...(value.preset === 'custom'
                      ? {}
                      : {
                          preset: {
                            name: 'lark' as const,
                            region: value.preset,
                          },
                        }),
                    authorizationEndpoint: value.authorizationEndpoint.trim(),
                    tokenEndpoint: value.tokenEndpoint.trim(),
                    userinfoEndpoint: value.userinfoEndpoint.trim(),
                    clientId: value.clientId.trim(),
                    ...(value.tokenEndpointAuthMethod === 'none' ||
                    !value.clientSecret
                      ? {}
                      : { clientSecret: value.clientSecret }),
                    tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
                    scopes: value.scopes,
                    mapping: mappingOf(value),
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
        if (!applyFieldErrors(form, caught, MAPPING_ERROR_FIELDS)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  // Fills the SAML fields from the provider's metadata (nothing is saved).
  const importFromUrl = async () => {
    setError(undefined);
    try {
      const imported = await importMetadata.mutateAsync(metadataUrl.trim());
      form.setFieldValue('idpEntityId', imported.idpEntityId);
      form.setFieldValue('idpSsoUrl', imported.idpSsoUrl);
      form.setFieldValue('certificate', imported.idpCertificates[0] ?? '');
      form.setFieldValue('nextCertificate', imported.idpCertificates[1] ?? '');
      toast.success(t('form.metadataImported'));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

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

  const mappingField = (
    name:
      | 'mappingRoot'
      | 'mappingSubject'
      | 'mappingEmail'
      | 'mappingName'
      | 'mappingPicture'
      | 'mappingGroups'
      | 'mappingErrorCode',
    label: string,
    hint: string,
    placeholder: string,
    mandatory = false,
  ) => (
    <form.AppField
      name={name}
      validators={mandatory ? required(t('form.required')) : undefined}
    >
      {(f) => (
        <f.TextField
          label={label}
          description={hint}
          placeholder={placeholder}
        />
      )}
    </form.AppField>
  );

  // Picking a preset fills the endpoints and the mapping (still editable);
  // "Custom" empties them. The client id and secret are left alone.
  const pickPreset = (preset: PresetChoice) => {
    const { preset: _preset, ...fields } = presetValues(preset);
    for (const [name, value] of Object.entries(fields)) {
      form.setFieldValue(name as keyof OAuth2Values, value as never);
    }
  };

  const oauth2Fields = (
    <>
      {!connection && (
        <form.AppField
          name="preset"
          listeners={{
            onChange: ({ value }) => pickPreset(value as PresetChoice),
          }}
        >
          {(f) => (
            <f.SelectField
              label={t('form.preset')}
              description={t('form.presetHint')}
              options={[
                { value: 'custom', label: t('preset.custom') },
                { value: 'lark', label: t('preset.lark') },
                { value: 'feishu', label: t('preset.feishu') },
              ]}
            />
          )}
        </form.AppField>
      )}
      {connection?.oauth2 ? (
        <CopyValue
          label={t('details.redirectUri')}
          value={connection.oauth2.redirectUri}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        {connection ? t('form.redirectHintEdit') : t('form.redirectHint')}
      </p>
      <form.AppField
        name="authorizationEndpoint"
        validators={url(t('form.urlInvalid'))}
      >
        {(f) => (
          <f.TextField
            label={t('form.authorizationEndpoint')}
            description={t('form.authorizationEndpointHint')}
            placeholder="https://provider.example.com/oauth/authorize"
          />
        )}
      </form.AppField>
      <form.AppField
        name="tokenEndpoint"
        validators={url(t('form.urlInvalid'))}
      >
        {(f) => (
          <f.TextField
            label={t('form.tokenEndpoint')}
            description={t('form.tokenEndpointHint')}
            placeholder="https://provider.example.com/oauth/token"
          />
        )}
      </form.AppField>
      <form.AppField
        name="userinfoEndpoint"
        validators={url(t('form.urlInvalid'))}
      >
        {(f) => (
          <f.TextField
            label={t('form.userinfoEndpoint')}
            description={t('form.userinfoEndpointHint')}
            placeholder="https://provider.example.com/api/user"
          />
        )}
      </form.AppField>
      <form.AppField name="clientId" validators={required(t('form.required'))}>
        {(f) => <f.TextField label={t('form.clientId')} />}
      </form.AppField>
      <form.AppField name="tokenEndpointAuthMethod">
        {(f) => (
          <f.SelectField
            label={t('form.authMethod')}
            description={t('form.authMethodHint')}
            options={AUTH_METHODS.map((method) => ({
              value: method,
              label: t(`authMethod.${method}`),
            }))}
          />
        )}
      </form.AppField>
      <form.Subscribe
        selector={(state) => state.values.tokenEndpointAuthMethod}
      >
        {(method) =>
          method === 'none' ? (
            <p className="text-xs text-muted-foreground">
              {t('form.publicClient')}
            </p>
          ) : (
            <form.AppField
              name="clientSecret"
              validators={{
                onSubmit: ({ value, fieldApi }) =>
                  connection ||
                  value ||
                  fieldApi.form.getFieldValue('tokenEndpointAuthMethod') ===
                    'none'
                    ? undefined
                    : { message: t('form.required') },
              }}
            >
              {(f) => (
                <f.TextField
                  label={t('form.clientSecret')}
                  type="password"
                  autoComplete="off"
                  description={
                    connection ? t('form.secretKeep') : t('form.secretHint')
                  }
                />
              )}
            </form.AppField>
          )
        }
      </form.Subscribe>
      <form.Field name="scopes">
        {(field) => (
          <Field>
            {/* Dice UI's tags-input: a scope per tag, pasted lists split. */}
            <TagsInput
              className="w-full"
              value={field.state.value}
              onValueChange={(next) => field.handleChange(next)}
              addOnPaste
              blurBehavior="add"
              delimiter=","
            >
              <TagsInputLabel>{t('form.scopes')}</TagsInputLabel>
              <TagsInputList>
                {field.state.value.map((scope) => (
                  <TagsInputItem key={scope} value={scope}>
                    {scope}
                  </TagsInputItem>
                ))}
                <TagsInputInput placeholder={t('form.scopesPlaceholder')} />
              </TagsInputList>
            </TagsInput>
            <FieldDescription>{t('form.scopesHint')}</FieldDescription>
          </Field>
        )}
      </form.Field>

      <h3 className="mt-2 text-sm font-medium">{t('form.mappingTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('form.mappingHint')}</p>
      {mappingField(
        'mappingRoot',
        t('form.mappingRoot'),
        t('form.mappingRootHint'),
        'data',
      )}
      {mappingField(
        'mappingSubject',
        t('form.mappingSubject'),
        t('form.mappingSubjectHint'),
        'data.open_id',
        true,
      )}
      {mappingField(
        'mappingEmail',
        t('form.mappingEmail'),
        t('form.mappingEmailHint'),
        'email',
      )}
      {mappingField(
        'mappingName',
        t('form.mappingName'),
        t('form.mappingNameHint'),
        'name',
      )}
      {mappingField(
        'mappingPicture',
        t('form.mappingPicture'),
        t('form.mappingPictureHint'),
        'avatar_url',
      )}
      {mappingField(
        'mappingGroups',
        t('form.mappingGroups'),
        t('form.mappingGroupsHint'),
        'groups',
      )}
      {mappingField(
        'mappingErrorCode',
        t('form.mappingErrorCode'),
        t('form.mappingErrorCodeHint'),
        'code',
      )}
      <form.AppField name="emailTrust">
        {(f) => (
          <f.SelectField
            label={t('form.emailTrust')}
            description={t('form.emailTrustHint')}
            options={(
              ['never', 'field', 'verified-domains'] as EmailTrust[]
            ).map((mode) => ({
              value: mode,
              label: t(`emailTrust.${mode}`),
            }))}
          />
        )}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.emailTrust}>
        {(trust) => (
          <>
            <p className="text-xs text-muted-foreground">
              {t(`emailTrust.${trust}Explain`)}
            </p>
            {trust === 'field' && (
              <form.AppField
                name="emailVerifiedPath"
                validators={required(t('form.required'))}
              >
                {(f) => (
                  <f.TextField
                    label={t('form.emailVerifiedPath')}
                    description={t('form.emailVerifiedPathHint')}
                    placeholder="email_verified"
                  />
                )}
              </form.AppField>
            )}
          </>
        )}
      </form.Subscribe>
    </>
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
                      { value: 'oauth2', label: t('protocol.oauth2') },
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
                protocol === 'oauth2' ? (
                  oauth2Fields
                ) : protocol === 'oidc' ? (
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
                    <Field>
                      <FieldLabel htmlFor="field-metadataUrl">
                        {t('form.metadataUrl')}
                      </FieldLabel>
                      <div className="flex gap-2">
                        <Input
                          id="field-metadataUrl"
                          value={metadataUrl}
                          onChange={(event) =>
                            setMetadataUrl(event.target.value)
                          }
                          placeholder="https://idp.example.com/metadata"
                          inputMode="url"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            !isUrl(metadataUrl.trim()) ||
                            importMetadata.isPending
                          }
                          onClick={() => void importFromUrl()}
                        >
                          {t('form.metadataImport')}
                        </Button>
                      </div>
                      <FieldDescription>
                        {t('form.metadataUrlHint')}
                      </FieldDescription>
                    </Field>
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
