import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import {
  accountQuery,
  consentKinds,
  type AccountState,
  type Consent,
} from '@/components/account/privacy-api';
import { api } from '@/lib/api';
import { useDateTimeFormat } from '@/lib/date-time';

/**
 * What you agreed to (`GET /v1/account`'s `consents`, the latest version of
 * each kind), and giving it (`POST /v1/account/consents`, audited). On means
 * the current version (`consentKinds`) was accepted. The API has no route
 * to withdraw a consent, so an accepted one stays on: a required one is
 * locked by design, an optional one until the API can withdraw it.
 */
export function ConsentsSection() {
  const { t } = useTranslation('privacy');
  const format = useDateTimeFormat();
  const queryClient = useQueryClient();
  const state = useQuery(accountQuery);
  const accept = useMutation({
    mutationFn: (body: { kind: string; version: string }) =>
      unwrap(api.POST('/v1/account/consents', { body })),
    onSuccess: (saved) => {
      queryClient.setQueryData<AccountState>(accountQuery.queryKey, (old) =>
        old
          ? {
              ...old,
              consents: [
                saved,
                ...old.consents.filter((c) => c.kind !== saved.kind),
              ],
            }
          : old,
      );
      toast.success(t('consents.given', { kind: label(saved.kind) }));
    },
  });
  const label = (kind: string) =>
    t(`consents.kinds.${kind}`, { defaultValue: kind });

  const given = new Map<string, Consent>(
    (state.data?.consents ?? []).map((c) => [c.kind, c]),
  );
  // A kind the API holds that this app no longer asks for: shown, read-only.
  const others = [...given.values()].filter(
    (c) => !consentKinds.some((k) => k.kind === c.kind),
  );

  return (
    <Section
      title={t('consents.title')}
      description={t('consents.description')}
    >
      {state.isPending ? (
        <Skeleton className="h-24 w-full" aria-busy />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {consentKinds.map((declared) => {
            const consent = given.get(declared.kind);
            const current = consent?.version === declared.version;
            const id = `consent-${declared.kind}`;
            const busy =
              accept.isPending && accept.variables?.kind === declared.kind;
            return (
              <li key={declared.kind} className="flex items-start gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor={id} className="text-sm font-medium">
                      {label(declared.kind)}
                    </label>
                    {declared.required && (
                      <Badge variant="secondary">
                        {t('consents.required')}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {consent
                      ? t(
                          current ? 'consents.acceptedAt' : 'consents.outdated',
                          {
                            version: consent.version,
                            current: declared.version,
                            date: format(consent.acceptedAt),
                          },
                        )
                      : t('consents.notGiven', { version: declared.version })}
                  </span>
                  {current && (
                    <span className="text-xs text-muted-foreground">
                      {declared.required
                        ? t('consents.locked')
                        : t('consents.noWithdraw')}
                    </span>
                  )}
                </div>
                <Switch
                  id={id}
                  aria-label={label(declared.kind)}
                  checked={current}
                  // Once the current version is given there is nothing to do
                  // with the switch: no route takes a consent back.
                  disabled={current || busy}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      accept.mutate({
                        kind: declared.kind,
                        version: declared.version,
                      });
                    }
                  }}
                />
              </li>
            );
          })}
          {others.map((consent) => (
            <li key={consent.kind} className="flex flex-col gap-1 p-3">
              <span className="text-sm font-medium">{label(consent.kind)}</span>
              <span className="text-xs text-muted-foreground">
                {t('consents.acceptedAt', {
                  version: consent.version,
                  date: format(consent.acceptedAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
