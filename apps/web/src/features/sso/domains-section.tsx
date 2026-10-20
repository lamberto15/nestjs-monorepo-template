import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { CopyValue } from './copy-value';
import {
  domainsQuery,
  useCreateDomain,
  useRemoveDomain,
  useVerifyDomain,
} from './queries';

/**
 * The email domains the tenant proves it owns (a TXT record): only their
 * addresses sign in through SSO or are provisioned.
 */
export function DomainsSection() {
  const { t } = useTranslation('sso');
  const domains = useQuery({ ...domainsQuery, meta: { errorToast: false } });
  const create = useCreateDomain();
  const verify = useVerifyDomain();
  const remove = useRemoveDomain();
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string>();

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sso-domains">
      <div>
        <h2 id="sso-domains" className="text-base font-medium">
          {t('domains.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('domains.description')}
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          create.mutate(domain.trim().toLowerCase(), {
            onSuccess: () => setDomain(''),
            onError: (caught) => setError(errorMessage(caught)),
          });
        }}
      >
        <div className="flex w-full flex-col gap-1 sm:w-72">
          <label htmlFor="sso-domain" className="text-sm font-medium">
            {t('domains.domain')}
          </label>
          <Input
            id="sso-domain"
            value={domain}
            placeholder="example.com"
            onChange={(event) => setDomain(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!domain.trim() || create.isPending}>
          {t('domains.add')}
        </Button>
      </form>
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
      {domains.isSuccess && domains.data.items.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('domains.none')}
        </p>
      )}
      {domains.isSuccess && (
        <ul className="flex flex-col gap-3">
          {domains.data.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-3 rounded-md border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium">
                  {item.domain}
                  <Badge variant={item.verified ? 'default' : 'secondary'}>
                    {item.verified
                      ? t('domains.verified')
                      : t('domains.unverified')}
                  </Badge>
                </span>
                <div className="flex gap-2">
                  {!item.verified && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={verify.isPending}
                      onClick={() =>
                        verify.mutate(item.id, {
                          onSuccess: () => toast.success(t('domains.checking')),
                        })
                      }
                    >
                      <CheckIcon />
                      {t('domains.verify')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('domains.removeLabel', {
                      domain: item.domain,
                    })}
                    onClick={() =>
                      remove.mutate(item.id, {
                        onSuccess: () =>
                          toast.success(
                            t('domains.removed', { domain: item.domain }),
                          ),
                      })
                    }
                  >
                    <Trash2Icon />
                    {t('domains.remove')}
                  </Button>
                </div>
              </div>
              {!item.verified && (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t('domains.publish')}
                  </p>
                  <dl className="grid gap-3 md:grid-cols-2">
                    <CopyValue
                      label={t('domains.recordName', {
                        type: item.record.type,
                      })}
                      value={item.record.name}
                    />
                    <CopyValue
                      label={t('domains.recordValue')}
                      value={item.record.value}
                    />
                  </dl>
                  {item.lastError && (
                    <p role="status" className="text-sm text-destructive">
                      {t('domains.lastError', {
                        error: item.lastError,
                        date: formatDateTime(item.lastCheckedAt),
                      })}
                    </p>
                  )}
                </>
              )}
              {item.verified && (
                <p className="text-xs text-muted-foreground">
                  {t('domains.verifiedAt', {
                    date: formatDateTime(item.verifiedAt),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
