import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useQuery } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { policyQuery, useRemoveExemption, useSetPolicy } from './queries';

/**
 * "SSO required" (docs/auth.md, "SSO required"): members act in the
 * workspace only through one of its connections, except the exempted
 * (break-glass) members, whom this page lists and can release. Granting an
 * exemption is not here yet.
 */
export function PolicySection() {
  const { t } = useTranslation('sso');
  const policy = useQuery({ ...policyQuery, meta: { errorToast: false } });
  const set = useSetPolicy();
  const release = useRemoveExemption();

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sso-policy">
      <div>
        <h2 id="sso-policy" className="text-base font-medium">
          {t('policy.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('policy.description')}
        </p>
      </div>
      {policy.isPending && <Skeleton className="h-24 w-full" aria-busy />}
      {policy.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(policy.error)}
        </p>
      )}
      {policy.isSuccess && (
        <>
          <div className="flex items-center gap-2">
            <Switch
              id="sso-require"
              checked={policy.data.requireSso}
              disabled={set.isPending}
              onCheckedChange={(requireSso) =>
                set.mutate(requireSso, {
                  onSuccess: () =>
                    toast.success(
                      t(requireSso ? 'policy.turnedOn' : 'policy.turnedOff'),
                    ),
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            />
            <label htmlFor="sso-require" className="text-sm">
              {t('policy.toggle')}
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t('policy.exemptions')}</h3>
            <p className="text-xs text-muted-foreground">
              {t('policy.exemptionsHint')}
            </p>
            {policy.data.exemptions.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('policy.noExemptions')}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {policy.data.exemptions.map((exemption) => (
                <li
                  key={exemption.userId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                >
                  <span>
                    <span className="font-medium">{exemption.name}</span>
                    <br />
                    <span className="text-muted-foreground">
                      {t('policy.exemption', {
                        email: exemption.email,
                        reason: exemption.reason,
                      })}{' '}
                      · {formatDateTime(exemption.createdAt)}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={release.isPending}
                    aria-label={t('policy.endExemptionLabel', {
                      name: exemption.name,
                    })}
                    onClick={() =>
                      release.mutate(exemption.userId, {
                        onSuccess: () =>
                          toast.success(
                            t('policy.exemptionEnded', {
                              name: exemption.name,
                            }),
                          ),
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    <Trash2Icon />
                    {t('policy.endExemption')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
