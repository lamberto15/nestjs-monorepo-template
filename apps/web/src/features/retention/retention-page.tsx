import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useDescribedBy, useStaleDraftSession } from '@/lib/form';
import {
  retentionRulesQuery,
  useSetRetention,
  type RetentionRule,
} from './api';

/**
 * The retention rules features declare and the tenant's choice for each
 * (docs/retention.md): on or off, and the days. The purge runs nightly on the
 * queue; records under a legal hold are always kept.
 */
export function RetentionPage() {
  const { t } = useTranslation('retention');
  const rules = useQuery({
    ...retentionRulesQuery,
    meta: { errorToast: false },
  });

  return (
    <Page width="narrow">
      <PageHeader title={t('title')} description={t('description')} />
      <Alert>
        <AlertDescription>{t('holds')}</AlertDescription>
      </Alert>
      {rules.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {rules.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(rules.error)}
        </p>
      )}
      {rules.isSuccess &&
        (rules.data.items.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          rules.data.items.map((rule) => (
            // Fresh state when the saved values change.
            <RuleCard
              key={`${rule.name}:${rule.enabled}:${rule.days}`}
              rule={rule}
            />
          ))
        ))}
    </Page>
  );
}

function RuleCard({ rule }: { rule: RetentionRule }) {
  const { t } = useTranslation('retention');
  const save = useSetRetention();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [days, setDays] = useState(String(rule.days));
  const [error, setError] = useState<string>();
  const staleDraftSession = useStaleDraftSession();

  const parsed = Number(days);
  const dirty = enabled !== rule.enabled || days !== String(rule.days);
  const switchId = `retention-${rule.name}-enabled`;
  const daysId = `retention-${rule.name}-days`;
  // The hint and the error describe the days (as lib/form.tsx's fields).
  const { descriptionId, errorId, describedBy } = useDescribedBy(true, !!error);

  async function onSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (staleDraftSession()) return;
    if (!Number.isInteger(parsed) || parsed < rule.minDays) {
      setError(t('minDays', { n: rule.minDays }));
      return;
    }
    setError(undefined);
    try {
      await save.mutateAsync({
        name: rule.name,
        change: { enabled, days: parsed },
      });
      toast.success(t('saved', { name: rule.label }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {rule.label}
          <Badge variant="secondary">{t(`action.${rule.action}`)}</Badge>
        </CardTitle>
        <CardDescription>
          {t(`actionHelp.${rule.action}`, { subject: rule.subject })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <Field orientation="horizontal">
            <Switch
              id={switchId}
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t('enabled', { name: rule.label })}
            />
            <FieldLabel htmlFor={switchId}>
              {enabled ? t('on') : t('off')}
            </FieldLabel>
          </Field>
          <Field className="max-w-xs">
            <FieldLabel htmlFor={daysId}>
              {t('days', { name: rule.label })}
            </FieldLabel>
            <Input
              id={daysId}
              type="number"
              inputMode="numeric"
              min={rule.minDays}
              max={36500}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
            />
            <FieldDescription id={descriptionId}>
              {t('daysHelp', { min: rule.minDays, def: rule.defaultDays })}
            </FieldDescription>
          </Field>
          {error && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {rule.lastRunAt
              ? t('lastRun', {
                  at: formatDateTime(rule.lastRunAt),
                  n: rule.lastCount ?? 0,
                })
              : t('neverRun')}
          </p>
          <div>
            <Button type="submit" disabled={!dirty || save.isPending}>
              {t('save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
