import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  clientsQuery,
  activeKeys,
  lastUsed,
} from '@/features/api-clients/queries';
import { formatDateTime } from '@/lib/date-time';
import { useCan, useFeature } from '@/lib/features';
import { CopyValue } from './copy-value';

/**
 * SCIM provisioning (docs/auth.md, "SCIM provisioning"). The API has no
 * route for the provisioning's state: the SCIM token is an API client's key
 * (its role holds `Access.provisionScim`), so this tab gives the endpoint to
 * hand to the identity provider and shows the API clients' keys and when
 * each last called, which is what the identity provider's syncs look like.
 */
export function ScimSection() {
  const { t } = useTranslation('sso');
  const canClients = useCan('Access.manageClients');
  const clientsOn = useFeature('apiClients');
  const showClients = canClients && clientsOn;
  const clients = useQuery({
    ...clientsQuery,
    enabled: showClients,
    meta: { errorToast: false },
  });
  const base = `${window.location.origin}/v1/scim`;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sso-scim">
      <div>
        <h2 id="sso-scim" className="text-base font-medium">
          {t('scim.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('scim.description')}</p>
      </div>
      <dl>
        <CopyValue label={t('scim.baseUrl')} value={base} />
      </dl>
      <ol className="list-decimal ps-5 text-sm text-muted-foreground">
        <li>{t('scim.step1')}</li>
        <li>{t('scim.step2')}</li>
        <li>{t('scim.step3')}</li>
      </ol>
      {showClients ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('scim.clients')}</h3>
          {clients.isPending && <Skeleton className="h-16 w-full" aria-busy />}
          {clients.isSuccess && clients.data.items.length === 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('scim.noClients')}
            </p>
          )}
          {clients.isSuccess && clients.data.items.length > 0 && (
            <ul className="flex flex-col gap-2">
              {clients.data.items.map((client) => {
                const last = lastUsed(client);
                return (
                  <li
                    key={client.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                  >
                    <Link
                      to="/api-clients/$id"
                      params={{ id: client.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {client.name}
                    </Link>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Badge variant={client.active ? 'default' : 'secondary'}>
                        {client.active ? t('scim.active') : t('scim.inactive')}
                      </Badge>
                      {t('scim.activeKeys', {
                        count: activeKeys(client).length,
                      })}
                      {' · '}
                      {last
                        ? t('scim.lastCall', { date: formatDateTime(last) })
                        : t('scim.neverCalled')}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('scim.noAccess')}</p>
      )}
    </section>
  );
}
