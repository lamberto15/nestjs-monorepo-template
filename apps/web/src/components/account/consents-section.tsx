import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import {
  accountQuery,
  consentKindsQuery,
  type AccountState,
  type Consent,
} from '@/components/account/privacy-api';
import { api } from '@/lib/api';
import { useDateTimeFormat } from '@/lib/date-time';

/**
 * What you agreed to: the kinds the API asks for (`GET
 * /v1/account/consent-kinds`, with their labels, current versions and which
 * are required) against what you gave (`GET /v1/account`'s `consents`, the
 * latest of each kind). On means the current version is in force; turning it
 * on gives it (`POST /v1/account/consents`), turning it off withdraws it
 * (`DELETE /v1/account/consents/{kind}`): as easy as giving it, no password.
 * A required kind (the terms, the privacy policy) can't be withdrawn: its
 * switch is locked, and deleting the account is the way out.
 */
export function ConsentsSection() {
  const { t, i18n } = useTranslation('privacy');
  const format = useDateTimeFormat();
  const queryClient = useQueryClient();
  const state = useQuery(accountQuery);
  const kinds = useQuery(consentKindsQuery(i18n.language));

  // Both answer with the kind's new state: put it where `GET /v1/account` has it.
  const keep = (saved: Consent) =>
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
  const accept = useMutation({
    mutationFn: (body: { kind: string; version: string; label: string }) =>
      unwrap(
        api.POST('/v1/account/consents', {
          body: { kind: body.kind, version: body.version },
        }),
      ),
    onSuccess: (saved, { label }) => {
      keep(saved);
      toast.success(t('consents.given', { kind: label }));
    },
  });
  const withdraw = useMutation({
    mutationFn: (body: { kind: string; label: string }) =>
      unwrap(
        api.DELETE('/v1/account/consents/{kind}', {
          params: { path: { kind: body.kind } },
        }),
      ),
    onSuccess: (saved, { label }) => {
      keep(saved);
      toast.success(t('consents.withdrawn', { kind: label }));
    },
  });
  const busyWith = (kind: string) =>
    (accept.isPending && accept.variables?.kind === kind) ||
    (withdraw.isPending && withdraw.variables?.kind === kind);

  const given = new Map<string, Consent>(
    (state.data?.consents ?? []).map((c) => [c.kind, c]),
  );
  // A kind the API holds that it no longer asks for: shown, and withdrawable.
  const others = [...given.values()].filter(
    (c) => !(kinds.data ?? []).some((k) => k.kind === c.kind),
  );

  return (
    <Section
      title={t('consents.title')}
      description={t('consents.description')}
    >
      {state.isPending || kinds.isPending ? (
        <Skeleton className="h-24 w-full" aria-busy />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {(kinds.data ?? []).map((declared) => {
            const consent = given.get(declared.kind);
            const withdrawnAt = consent?.withdrawnAt ?? null;
            const current = consent?.version === declared.version;
            const inForce = current && withdrawnAt === null;
            const id = `consent-${declared.kind}`;
            return (
              <li key={declared.kind} className="flex items-start gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor={id} className="text-sm font-medium">
                      {declared.label}
                    </label>
                    {declared.required && (
                      <Badge variant="secondary">
                        {t('consents.required')}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {declared.description}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {!consent
                      ? t('consents.notGiven', { version: declared.version })
                      : withdrawnAt !== null
                        ? t('consents.withdrawnAt', {
                            date: format(withdrawnAt),
                          })
                        : t(
                            current
                              ? 'consents.acceptedAt'
                              : 'consents.outdated',
                            {
                              version: consent.version,
                              current: declared.version,
                              date: format(consent.acceptedAt),
                            },
                          )}
                  </span>
                  {inForce && (
                    <span className="text-xs text-muted-foreground">
                      {declared.required
                        ? t('consents.locked')
                        : t('consents.withdrawable')}
                    </span>
                  )}
                </div>
                <Switch
                  id={id}
                  aria-label={declared.label}
                  checked={inForce}
                  // A required consent stays on: only deleting the account
                  // ends it. An optional one is turned off to withdraw it.
                  disabled={
                    busyWith(declared.kind) || (inForce && declared.required)
                  }
                  onCheckedChange={(checked) => {
                    if (checked) {
                      accept.mutate({
                        kind: declared.kind,
                        version: declared.version,
                        label: declared.label,
                      });
                    } else {
                      withdraw.mutate({
                        kind: declared.kind,
                        label: declared.label,
                      });
                    }
                  }}
                />
              </li>
            );
          })}
          {others.map((consent) => (
            <li key={consent.kind} className="flex items-start gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium">{consent.kind}</span>
                <span className="text-xs text-muted-foreground">
                  {consent.withdrawnAt
                    ? t('consents.withdrawnAt', {
                        date: format(consent.withdrawnAt),
                      })
                    : t('consents.acceptedAt', {
                        version: consent.version,
                        date: format(consent.acceptedAt),
                      })}
                </span>
              </div>
              {!consent.withdrawnAt && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`${t('consents.withdraw')}: ${consent.kind}`}
                  disabled={busyWith(consent.kind)}
                  onClick={() =>
                    withdraw.mutate({ kind: consent.kind, label: consent.kind })
                  }
                >
                  {t('consents.withdraw')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
