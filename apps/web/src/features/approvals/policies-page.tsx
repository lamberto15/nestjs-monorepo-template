import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/errors';
import { policiesQuery, type PolicyView } from './api';

/** Where a policy comes from: the code's default (version 0), or a version an administrator stored. */
export function SourceBadge({ policy }: { policy: PolicyView }) {
  const { t } = useTranslation('approvals');
  return policy.source === 'override' ? (
    <Badge variant="secondary">
      {t('policies.source.override', { version: policy.version })}
    </Badge>
  ) : (
    <Badge variant="outline">{t('policies.source.code')}</Badge>
  );
}

/** `/approval-policies`: every action that can need approval, and the policy in force for it. */
export function PoliciesPage() {
  const { t } = useTranslation('approvals');
  const policies = useQuery({ ...policiesQuery, meta: { errorToast: false } });
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">{t('policies.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('policies.description')}
        </p>
      </div>
      {policies.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {policies.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(policies.error)}
        </p>
      )}
      {policies.isSuccess &&
        (policies.data.length === 0 ? (
          <p
            role="status"
            className="py-12 text-center text-sm text-muted-foreground"
          >
            {t('policies.none')}
          </p>
        ) : (
          <ul aria-label={t('policies.title')} className="rounded-lg border">
            {policies.data.map((policy) => (
              <PolicyRow key={policy.key} policy={policy} />
            ))}
          </ul>
        ))}
    </div>
  );
}

function PolicyRow({ policy }: { policy: PolicyView }) {
  const { t } = useTranslation('approvals');
  const { stages, enabled, when } = policy.policy;
  return (
    <li className="flex flex-wrap items-center gap-3 border-b p-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/approval-policies/$key"
            params={{ key: policy.key }}
            className="font-medium hover:underline"
          >
            {policy.label}
          </Link>
          <SourceBadge policy={policy} />
          {!enabled && <Badge variant="destructive">{t('policies.off')}</Badge>}
          {when && <Badge variant="outline">{t('policies.conditional')}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          <code>{policy.key}</code>
          {policy.description && ` · ${policy.description}`}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('policies.stagesSummary', {
            count: stages.length,
            names: stages.map((stage) => stage.name).join(' → '),
          })}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        aria-label={t('policies.editLabel', { label: policy.label })}
        nativeButton={false}
        render={
          <Link to="/approval-policies/$key" params={{ key: policy.key }} />
        }
      >
        {t('policies.edit')}
      </Button>
    </li>
  );
}
