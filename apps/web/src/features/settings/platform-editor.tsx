import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Slider } from '@nestjs-monorepo-template/ui/components/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RulesEditor } from './rules-editor';
import { api } from '@/lib/api';
import { catalogQuery } from '@/features/transfer/api';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { useStaleDraftSession } from '@/lib/form';
import {
  fromDraft,
  settingsQuery,
  toDraft,
  type Draft,
  type Rule,
  type Setting,
} from './settings';
import {
  ValueInput,
  boundsHint,
  formatValue,
  invalidText,
} from './value-input';

/**
 * The value the deployment's operators set for every tenant
 * (`PUT`/`DELETE /v1/settings/{key}/platform`, docs/settings.md): shown to
 * whoever manages the setting; editable only where the API says so
 * (`canEditPlatform`, never guessed). `enforced` is a kill switch: it beats
 * every tenant, team and user value.
 */
export function PlatformEditor({ setting }: { setting: Setting }) {
  const { t } = useTranslation('settings');
  const { t: modeT } = useTranslation('mode');
  const [pendingMode, setPendingMode] = useState<{
    value: 'maintenance' | 'read-only';
    enforced: boolean;
  } | null>(null);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const staleDraftSession = useStaleDraftSession();
  const stored = setting.platform;
  const [draft, setDraft] = useState<Draft>(
    toDraft(setting, stored?.value ?? setting.default),
  );
  const [enforced, setEnforced] = useState(stored?.enforced ?? false);
  // A flag may be rolled out to a share of principals instead of a value.
  const [mode, setMode] = useState<'value' | 'rollout'>(
    stored?.rollout != null && stored.value == null ? 'rollout' : 'value',
  );
  const [rollout, setRollout] = useState(String(stored?.rollout ?? 10));
  const rolling = setting.flag && mode === 'rollout';
  const hint = boundsHint(setting, t);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: catalogQuery.queryKey }),
    ]);
  const save = useMutation({
    mutationFn: (body: {
      value?: unknown;
      enforced?: boolean;
      rollout?: number;
      rules?: Rule[];
    }) =>
      unwrap(
        api.PUT('/v1/settings/{key}/platform', {
          params: { path: { key: setting.key } },
          body,
        }),
      ),
    meta: { errorToast: false },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () =>
      api
        .DELETE('/v1/settings/{key}/platform', {
          params: { path: { key: setting.key } },
        })
        .then(({ error: failed }) => {
          if (failed) {
            throw failed;
          }
        }),
    onSuccess: async () => {
      await refresh();
      toast.success(t('platform.removed'));
    },
  });

  // A flag always shows the section, so whoever can't set it learns who can.
  if (!stored && !setting.canEditPlatform && !setting.flag) {
    return null;
  }
  /**
   * Saves the targeting rules beside the value or rollout already set (the
   * PUT replaces them); with neither and no rules left, the platform value
   * goes.
   */
  const saveRules = async (rules: Rule[]) => {
    if (staleDraftSession()) return;
    const own = stored && (stored.rollout != null || stored.value != null);
    if (!rules.length && !own) {
      if (stored) await remove.mutateAsync();
    } else {
      await save.mutateAsync({
        rules,
        ...(stored?.value != null
          ? { value: stored.value, enforced: stored.enforced }
          : stored?.rollout != null
            ? { rollout: stored.rollout }
            : {}),
      });
    }
    toast.success(t('rules.saved'));
  };
  const submit = async () => {
    if (staleDraftSession()) return;
    setError(undefined);
    const percent = Number(rollout);
    if (rolling && !(percent >= 0 && percent <= 100)) {
      setError(t('invalid.rollout'));
      return;
    }
    const parsed = fromDraft(setting, draft);
    if (!rolling && !parsed.ok) {
      setError(invalidText(parsed.invalid, t));
      return;
    }
    // Global deployment modes affect *every* tenant, immediately. Do not
    // activate them through a form submit without the operator's consent.
    if (
      setting.key === 'platform.mode' &&
      !rolling &&
      parsed.ok &&
      (parsed.value === 'maintenance' || parsed.value === 'read-only')
    ) {
      setPendingMode({ value: parsed.value, enforced });
      return;
    }
    try {
      await save.mutateAsync(
        rolling
          ? { rollout: percent }
          : { value: parsed.ok ? parsed.value : undefined, enforced },
      );
      toast.success(t('platform.saved'));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section aria-label={t('platform.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t('platform.title')}</h3>
      {setting.canEditPlatform && (
        <p className="text-xs text-muted-foreground">
          {t('platform.description')}
        </p>
      )}
      {!setting.canEditPlatform && (
        <p className="text-xs text-muted-foreground">
          {t('platform.operatorsOnly')}
        </p>
      )}
      {stored ? (
        <p className="flex items-center gap-2 text-sm">
          <strong>
            {stored.value == null && stored.rollout != null
              ? t('platform.rolloutOf', { percent: stored.rollout })
              : stored.value == null && stored.rules.length
                ? t('rules.only')
                : formatValue(stored.value, t('on'), t('off'))}
          </strong>
          {stored.rules.length > 0 && (
            <span>{t('rules.count', { count: stored.rules.length })}</span>
          )}
          <Badge variant={stored.enforced ? 'default' : 'outline'}>
            {stored.enforced
              ? t('platform.enforced')
              : t('platform.notEnforced')}
          </Badge>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{t('platform.none')}</p>
      )}
      {setting.canEditPlatform && (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormAlert message={error} />
          {setting.flag && (
            <Field>
              <FieldLabel htmlFor="field-platform-mode">
                {t('mode.label')}
              </FieldLabel>
              <Select
                items={[
                  { value: 'value', label: t('mode.value') },
                  { value: 'rollout', label: t('mode.rollout') },
                ]}
                value={mode}
                onValueChange={(next) =>
                  setMode(next === 'rollout' ? 'rollout' : 'value')
                }
              >
                <SelectTrigger
                  id="field-platform-mode"
                  aria-label={t('mode.label')}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="value">{t('mode.value')}</SelectItem>
                  <SelectItem value="rollout">{t('mode.rollout')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {rolling ? (
            <Field>
              <FieldLabel htmlFor="field-platform-rollout">
                {t('rollout.label')}
              </FieldLabel>
              <Slider
                aria-label={t('rollout.label')}
                min={0}
                max={100}
                value={[Number(rollout) || 0]}
                onValueChange={(next) =>
                  setRollout(String(Array.isArray(next) ? next[0] : next))
                }
              />
              <Input
                id="field-platform-rollout"
                type="number"
                min={0}
                max={100}
                value={rollout}
                onChange={(event) => setRollout(event.target.value)}
              />
              <FieldDescription>{t('rollout.description')}</FieldDescription>
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="field-platform-draft">
                  {t('valueLabel')}
                </FieldLabel>
                <ValueInput
                  id="field-platform-draft"
                  label={`${t('platform.title')}: ${t('valueLabel')}`}
                  spec={setting}
                  value={draft}
                  onChange={setDraft}
                />
                {hint && <FieldDescription>{hint}</FieldDescription>}
              </Field>
              <Field orientation="horizontal">
                <Switch
                  id="field-platform-enforced"
                  checked={enforced}
                  onCheckedChange={setEnforced}
                />
                <div className="flex flex-col gap-1">
                  <FieldLabel htmlFor="field-platform-enforced">
                    {t('platform.enforcedLabel')}
                  </FieldLabel>
                  <FieldDescription>
                    {t('platform.enforcedHint')}
                  </FieldDescription>
                </div>
              </Field>
            </>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>
              {t('platform.save')}
            </Button>
            {stored && (
              <ConfirmButton
                variant="outline"
                // The operators' routes answer in read-only and maintenance
                // mode too: this is how the mode is turned off again.
                allowInMaintenance
                title={t('platform.removeTitle')}
                description={t('platform.removeDescription')}
                confirm={t('platform.remove')}
                onConfirm={() => remove.mutateAsync()}
              >
                {t('platform.remove')}
              </ConfirmButton>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={pendingMode != null}
        onOpenChange={(open) => {
          if (!open) setPendingMode(null);
        }}
        title={modeT(`confirm.${pendingMode?.value ?? 'maintenance'}.title`)}
        description={modeT(
          `confirm.${pendingMode?.value ?? 'maintenance'}.description`,
        )}
        confirm={modeT('confirm.apply')}
        onConfirm={async () => {
          if (!pendingMode) return;
          if (staleDraftSession()) return;
          try {
            await save.mutateAsync({
              value: pendingMode.value,
              enforced: pendingMode.enforced,
            });
            toast.success(t('platform.saved'));
          } catch (caught) {
            setError(errorMessage(caught));
            throw caught;
          }
        }}
      />
      {setting.flag && setting.canEditPlatform && (
        <section
          aria-label={t('rules.platformTitle')}
          className="mt-2 flex flex-col gap-2"
        >
          <h4 className="text-sm font-medium">{t('rules.platformTitle')}</h4>
          <p className="text-xs text-muted-foreground">
            {t('rules.platformDescription')}
          </p>
          <RulesEditor
            key={JSON.stringify(stored?.rules ?? [])}
            scope="platform"
            rules={stored?.rules}
            onSave={saveRules}
          />
        </section>
      )}
    </section>
  );
}
