import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { CheckIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CopyValue } from '@/features/sso/copy-value';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useStaleDraftSession } from '@/lib/form';

type Domains = GetResponse<'/v1/branding/domains'>;

const domainsQuery = queryOptions({
  queryKey: ['branding', 'domains'],
  queryFn: () => unwrap(api.GET('/v1/branding/domains')),
});

function useDomainMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: domainsQuery.queryKey }),
  });
}

/**
 * The tenant's custom domains (docs/branding.md, "Custom domains"): a
 * hostname of its own, proved by a TXT record, then served with its brand.
 * Shown only when the deployment serves them (`enabled`); adding and
 * checking are off while the operators lock the branding.
 */
export function DomainsSection(props: { locked: boolean }) {
  const { t } = useTranslation('branding');
  const domains = useQuery({ ...domainsQuery, meta: { errorToast: false } });
  const create = useDomainMutation((hostname: string) =>
    unwrap(api.POST('/v1/branding/domains', { body: { hostname } })),
  );
  const verify = useDomainMutation((id: string) =>
    unwrap(
      api.POST('/v1/branding/domains/{id}/verify', {
        params: { path: { id } },
      }),
    ),
  );
  const remove = useDomainMutation((id: string) =>
    unwrap(
      api.DELETE('/v1/branding/domains/{id}', { params: { path: { id } } }),
    ),
  );
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string>();
  const staleDraftSession = useStaleDraftSession();

  if (domains.isSuccess && !domains.data.enabled) {
    return null;
  }
  return (
    <section className="flex flex-col gap-4" aria-labelledby="branding-domains">
      <div>
        <h2 id="branding-domains" className="text-base font-medium">
          {t('domains.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('domains.description')}
        </p>
      </div>
      {!props.locked && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (staleDraftSession()) return;
            setError(undefined);
            create.mutate(hostname.trim(), {
              onSuccess: () => setHostname(''),
              onError: (caught) => setError(errorMessage(caught)),
            });
          }}
        >
          <div className="flex w-full flex-col gap-1 sm:w-72">
            <label htmlFor="branding-domain" className="text-sm font-medium">
              {t('domains.hostname')}
            </label>
            <Input
              id="branding-domain"
              value={hostname}
              placeholder="app.example.com"
              onChange={(event) => setHostname(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={!hostname.trim() || create.isPending}>
            {t('domains.add')}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {domains.isPending && <Skeleton className="h-20 w-full" aria-busy />}
      {domains.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(domains.error)}
        </p>
      )}
      {domains.isSuccess && domains.data.domains.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('domains.none')}
        </p>
      )}
      {domains.isSuccess && (
        <ul className="flex flex-col gap-3">
          {domains.data.domains.map((item) => (
            <DomainItem
              key={item.id}
              item={item}
              locked={props.locked}
              checking={verify.isPending}
              onVerify={() =>
                verify.mutate(item.id, {
                  onSuccess: () => toast.success(t('domains.checking')),
                })
              }
              onRemove={() =>
                remove.mutate(item.id, {
                  onSuccess: () =>
                    toast.success(
                      t('domains.removed', { hostname: item.hostname }),
                    ),
                })
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DomainItem(props: {
  item: Domains['domains'][number];
  locked: boolean;
  checking: boolean;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('branding');
  const { item } = props;
  return (
    <li className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium break-all">
          {item.hostname}
          <Badge variant={item.verified ? 'default' : 'secondary'}>
            {item.verified ? t('domains.verified') : t('domains.unverified')}
          </Badge>
        </span>
        <div className="flex gap-2">
          {!props.locked && (
            <Button
              variant="outline"
              size="sm"
              disabled={props.checking}
              onClick={props.onVerify}
            >
              <CheckIcon />
              {t('domains.verify')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-label={t('domains.removeLabel', { hostname: item.hostname })}
            onClick={props.onRemove}
          >
            <Trash2Icon />
            {t('domains.remove')}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {item.verified ? t('domains.keep') : t('domains.publish')}
      </p>
      <dl className="grid gap-3 md:grid-cols-2">
        <CopyValue
          label={t('domains.recordName', { type: item.record.type })}
          value={item.record.name}
        />
        <CopyValue label={t('domains.recordValue')} value={item.record.value} />
      </dl>
      {item.lastError && (
        <p role="status" className="text-sm text-destructive">
          {t('domains.lastError', {
            error: item.lastError,
            date: formatDateTime(item.lastCheckedAt),
          })}
        </p>
      )}
      {item.verified && (
        <p className="text-xs text-muted-foreground">
          {t('domains.verifiedAt', { date: formatDateTime(item.verifiedAt) })}
        </p>
      )}
    </li>
  );
}
