import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Slider } from '@nestjs-monorepo-template/ui/components/slider';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  fromDraft,
  kindOf,
  overrideBody,
  overridesQuery,
  settingsQuery,
  toDraft,
  type Draft,
  type Override,
  type Scope,
  type Setting,
} from './settings';
import { ValueInput, formatValue } from './value-input';

const teamsQuery = {
  queryKey: ['access', 'teams'] as QueryKey,
  queryFn: async () => (await unwrap(api.GET('/v1/access/teams'))).items,
};
const usersQuery = {
  queryKey: ['access', 'users', 'settings-picker'] as QueryKey,
  queryFn: async () => {
    // The route declares no body type (a backend gap): the fields asked for.
    const page = (await unwrap(
      api.GET('/v1/access/users', {
        params: { query: { limit: 100, fields: 'name,email' } },
      }),
    )) as unknown as { items?: { id: string; name: string; email: string }[] };
    return page.items ?? [];
  },
};

type Mode = 'value' | 'rollout';

/**
 * Sets a setting at a scope (`PUT /v1/settings/{key}`), or, for a flag at the
 * tenant scope, a rollout: a percentage of the tenant's principals. Lists the
 * stored overrides, each of which can be edited or cleared.
 */
export function OverrideEditor({ setting }: { setting: Setting }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const kind = kindOf(setting);
  const [error, setError] = useState<string>();
  const overrides = useQuery(overridesQuery(setting.key));
  const hasTeam = setting.scopes.includes('team');
  const hasUser = setting.scopes.includes('user');
  const teams = useQuery({
    ...teamsQuery,
    enabled: hasTeam,
    meta: { errorToast: false },
  });
  const users = useQuery({
    ...usersQuery,
    enabled: hasUser,
    meta: { errorToast: false },
  });
  const scopeOptions = setting.scopes.map((scope) => ({
    value: scope,
    label: t(`scope.${scope}`),
  }));
  const idOptions = (scope: Scope) =>
    scope === 'team'
      ? (teams.data ?? []).map((team) => ({ value: team.id, label: team.name }))
      : (users.data ?? []).map((user) => ({
          value: `user:${user.id}`,
          label: `${user.name} (${user.email})`,
        }));

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
      queryClient.invalidateQueries({
        queryKey: overridesQuery(setting.key).queryKey,
      }),
    ]);
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof overrideBody>) =>
      unwrap(
        api.PUT('/v1/settings/{key}', {
          params: { path: { key: setting.key } },
          body,
        }),
      ),
    meta: { errorToast: false },
    onSuccess: refresh,
  });
  const clear = useMutation({
    mutationFn: (override: Pick<Override, 'scope' | 'scopeId'>) =>
      api
        .DELETE('/v1/settings/{key}', {
          params: {
            path: { key: setting.key },
            query: {
              scope: override.scope,
              ...(override.scopeId ? { scopeId: override.scopeId } : {}),
            },
          },
        })
        .then(({ error: failed }) => {
          if (failed) {
            throw failed;
          }
        }),
    onSuccess: refresh,
  });

  const initial = overrides.data?.find((o) => o.scope === 'tenant');
  const form = useAppForm({
    defaultValues: {
      scope: setting.scopes[0] as Scope,
      scopeId: '',
      mode: (initial?.rollout != null ? 'rollout' : 'value') as Mode,
      draft: toDraft(kind, initial?.value ?? setting.value) as Draft,
      rollout: String(initial?.rollout ?? 10),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const rollout = value.mode === 'rollout' && value.scope === 'tenant';
      const parsed = fromDraft(kind, value.draft);
      const percent = Number(value.rollout);
      if (rollout ? !(percent >= 0 && percent <= 100) : !parsed.ok) {
        setError(t(rollout ? 'invalid.rollout' : `invalid.${kind}`));
        return;
      }
      try {
        await save.mutateAsync(
          overrideBody({
            scope: value.scope,
            scopeId: value.scopeId,
            ...(rollout
              ? { rollout: percent }
              : { value: parsed.ok ? parsed.value : undefined }),
          }),
        );
        toast.success(t('saved'));
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  /** Loads a stored override (or the setting's value) into the form. */
  const pick = (scope: Scope, scopeId: string) => {
    const stored = overrides.data?.find(
      (o) => o.scope === scope && o.scopeId === scopeId,
    );
    form.setFieldValue('scope', scope);
    form.setFieldValue('scopeId', scopeId);
    form.setFieldValue('mode', stored?.rollout != null ? 'rollout' : 'value');
    form.setFieldValue('draft', toDraft(kind, stored?.value ?? setting.value));
    form.setFieldValue('rollout', String(stored?.rollout ?? 10));
  };
  const labelOf = (override: Override) => {
    if (override.scope === 'tenant') {
      return t('scope.tenant');
    }
    const found = idOptions(override.scope).find(
      (o) => o.value === override.scopeId,
    );
    return `${t(`scope.${override.scope}`)}: ${found?.label ?? override.scopeId}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t('overrides')} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('overrides')}</h3>
        {overrides.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noOverrides')}</p>
        )}
        <ul className="flex flex-col gap-2">
          {overrides.data?.map((override) => (
            <li
              key={`${override.scope}:${override.scopeId}`}
              className="flex items-center gap-2 text-sm"
            >
              <span className="flex-1">
                {labelOf(override)}:{' '}
                <strong>
                  {override.rollout == null
                    ? formatValue(override.value, t('on'), t('off'))
                    : t('rolloutOf', { percent: override.rollout })}
                </strong>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => pick(override.scope, override.scopeId)}
              >
                {t('edit')}
              </Button>
              <ConfirmButton
                variant="ghost"
                size="sm"
                title={t('clearTitle')}
                description={t('clearDescription', {
                  label: labelOf(override),
                })}
                confirm={t('clear')}
                onConfirm={() => clear.mutateAsync(override)}
              >
                {t('clear')}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      </section>

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <FormAlert message={error} />
          <form.AppField name="scope">
            {(field) => (
              <field.SelectField
                label={t('scopeLabel')}
                options={scopeOptions}
              />
            )}
          </form.AppField>
          <form.Subscribe selector={(state) => state.values.scope}>
            {(scope) => {
              if (scope === 'tenant') {
                return null;
              }
              // The picker is rebuilt with the scope: a team's id is not a user's.
              return (
                <form.AppField name="scopeId" key={scope}>
                  {(field) => (
                    <field.SelectField
                      label={t(`scopeId.${scope}`)}
                      options={idOptions(scope)}
                    />
                  )}
                </form.AppField>
              );
            }}
          </form.Subscribe>
          <form.Subscribe selector={(state) => state.values}>
            {(values) => {
              const canRoll = setting.flag && values.scope === 'tenant';
              return (
                <>
                  {canRoll && (
                    <form.AppField name="mode">
                      {(field) => (
                        <field.SelectField
                          label={t('mode.label')}
                          options={[
                            { value: 'value', label: t('mode.value') },
                            { value: 'rollout', label: t('mode.rollout') },
                          ]}
                        />
                      )}
                    </form.AppField>
                  )}
                  {canRoll && values.mode === 'rollout' ? (
                    <form.Field name="rollout">
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor="field-rollout">
                            {t('rollout.label')}
                          </FieldLabel>
                          <Slider
                            aria-label={t('rollout.label')}
                            min={0}
                            max={100}
                            value={[Number(field.state.value) || 0]}
                            onValueChange={(next) =>
                              field.handleChange(
                                String(Array.isArray(next) ? next[0] : next),
                              )
                            }
                          />
                          <Input
                            id="field-rollout"
                            type="number"
                            min={0}
                            max={100}
                            value={field.state.value}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                          />
                          <FieldDescription>
                            {t('rollout.description')}
                          </FieldDescription>
                        </Field>
                      )}
                    </form.Field>
                  ) : (
                    <form.Field name="draft">
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor="field-draft">
                            {t('valueLabel')}
                          </FieldLabel>
                          <ValueInput
                            id="field-draft"
                            label={t('valueLabel')}
                            kind={kind}
                            value={field.state.value}
                            onChange={field.handleChange}
                          />
                        </Field>
                      )}
                    </form.Field>
                  )}
                </>
              );
            }}
          </form.Subscribe>
          <form.AppForm>
            <form.SubmitButton className="self-start">
              {t('save')}
            </form.SubmitButton>
          </form.AppForm>
        </FieldGroup>
      </form>
    </div>
  );
}
