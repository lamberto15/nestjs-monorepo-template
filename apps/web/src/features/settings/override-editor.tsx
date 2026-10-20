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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { PrincipalPicker } from '@/components/principal-picker';
import { PersonPicker } from '@/components/person-picker';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { holds, useMe, type Permission } from '@/lib/features';
import { FormAlert, useAppForm } from '@/lib/form';
import { teamRefsQuery } from '@/lib/list-refs';
import { usePeopleNames, useTeamNames } from '@/lib/people';
import { PlatformEditor } from './platform-editor';
import {
  fromDraft,
  overrideBody,
  overridesQuery,
  settingsQuery,
  toDraft,
  type Draft,
  type Override,
  type Scope,
  type Setting,
} from './settings';
import {
  ValueInput,
  boundsHint,
  formatValue,
  invalidText,
} from './value-input';

type Mode = 'value' | 'rollout';

/**
 * Who may search the tenant's principals (`GET /v1/access/principals`, the
 * API's `AccessPolicy.open`): the access administrators. Whoever manages
 * settings alone searches the members (`GET /v1/people`) instead, so no
 * request is made just to be refused.
 */
const principalReaders: Permission[] = [
  'Access.manageRoles',
  'Access.manageUsers',
  'Access.manageClients',
  'Access.manageTeams',
  'Access.impersonate',
  'Access.readAudit',
];

/**
 * Sets a setting at a scope (`PUT /v1/settings/{key}`), or, for a flag at the
 * tenant scope, a rollout: a percentage of the tenant's principals. Lists the
 * stored overrides, each of which can be edited or cleared. A user scope's
 * value is for a user or an API client, found by searching the principals
 * (`GET /v1/access/principals`): its `key` is the `scopeId`; stored ones
 * are named by the people and teams lookups.
 */
export function OverrideEditor({ setting }: { setting: Setting }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const overrides = useQuery(overridesQuery(setting.key));
  const hasTeam = setting.scopes.includes('team');
  // The teams, from the route every member may read.
  const teams = useQuery({ ...teamRefsQuery, enabled: hasTeam });
  const mayReadPrincipals = holds(useMe()?.can, principalReaders);
  // Names for the stored values, by key and id (every member may read them).
  const people = usePeopleNames(
    (overrides.data ?? [])
      .filter((o) => o.scope === 'user')
      .map((o) => o.scopeId),
  );
  const teamNames = useTeamNames(
    (overrides.data ?? [])
      .filter((o) => o.scope === 'team')
      .map((o) => o.scopeId),
  );
  const scopeOptions = setting.scopes.map((scope) => ({
    value: scope,
    label: t(`scope.${scope}`),
  }));
  const teamOptions = (teams.data ?? []).map((team) => ({
    value: team.id,
    label: team.name,
  }));
  const nameOf = (scope: Scope, scopeId: string) => {
    if (scope === 'team') {
      return (
        teamOptions.find((o) => o.value === scopeId)?.label ??
        teamNames.get(scopeId)
      );
    }
    return people.get(scopeId);
  };
  const hint = boundsHint(setting, t);

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
      draft: toDraft(setting, initial?.value ?? setting.value) as Draft,
      rollout: String(initial?.rollout ?? 10),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const rollout = value.mode === 'rollout' && value.scope === 'tenant';
      const parsed = fromDraft(setting, value.draft);
      const percent = Number(value.rollout);
      if (rollout && !(percent >= 0 && percent <= 100)) {
        setError(t('invalid.rollout'));
        return;
      }
      if (!rollout && !parsed.ok) {
        setError(invalidText(parsed.invalid, t));
        return;
      }
      if (value.scope !== 'tenant' && !value.scopeId) {
        setError(t(`invalid.scopeId.${value.scope}`));
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
    form.setFieldValue(
      'draft',
      toDraft(setting, stored?.value ?? setting.value),
    );
    form.setFieldValue('rollout', String(stored?.rollout ?? 10));
  };
  const labelOf = (override: Override) => {
    if (override.scope === 'tenant') {
      return t('scope.tenant');
    }
    const name = nameOf(override.scope, override.scopeId) ?? override.scopeId;
    return `${t(`scope.${override.scope}`)}: ${name}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PlatformEditor setting={setting} />
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
              return scope === 'team' ? (
                <form.AppField name="scopeId" key={scope}>
                  {(field) => (
                    <field.SelectField
                      label={t('scopeId.team')}
                      options={teamOptions}
                    />
                  )}
                </form.AppField>
              ) : (
                <form.Field name="scopeId" key={scope}>
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor="field-scopeId">
                        {t('scopeId.user')}
                      </FieldLabel>
                      {mayReadPrincipals ? (
                        <PrincipalPicker
                          id="field-scopeId"
                          label={t('scopeId.user')}
                          value={field.state.value}
                          initialLabel={
                            field.state.value
                              ? nameOf('user', field.state.value)
                              : undefined
                          }
                          onChange={(value) => field.handleChange(value)}
                        />
                      ) : (
                        <PersonPicker
                          id="field-scopeId"
                          label={t('scopeId.user')}
                          value={field.state.value}
                          initialLabel={
                            field.state.value
                              ? nameOf('user', field.state.value)
                              : undefined
                          }
                          onChange={(value) => field.handleChange(value)}
                        />
                      )}
                      <FieldDescription>{t('scopeIdHint')}</FieldDescription>
                    </Field>
                  )}
                </form.Field>
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
                            spec={setting}
                            value={field.state.value}
                            onChange={field.handleChange}
                          />
                          {hint && <FieldDescription>{hint}</FieldDescription>}
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
