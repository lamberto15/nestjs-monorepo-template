import { useQuery } from '@tanstack/react-query';
import { buttonVariants } from '@nestjs-monorepo-template/ui/components/button';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { clientsQuery } from '@/features/api-clients/queries';

/**
 * Webhooks belong to an API client (it is the webhooks' tenant, and what a
 * delivery carries is what it may read), so the way in is the client.
 */
export function WebhookClientsPage() {
  const { t } = useTranslation('webhooks');
  const list = useQuery(clientsQuery);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-medium">{t('clients.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('clients.description')}
          </p>
        </div>
        <Link
          to="/webhooks/senders"
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('clients.senders')}
        </Link>
      </div>
      {list.isPending ? (
        <Spinner />
      ) : list.data?.items.length ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('clients.name')}</TableHead>
                <TableHead>{t('clients.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/webhooks/$clientId"
                      params={{ clientId: client.id }}
                      className="underline-offset-4 hover:underline"
                    >
                      {client.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={client.active ? 'default' : 'outline'}>
                      {t(`clients.${client.active ? 'active' : 'revoked'}`)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('clients.empty')}</p>
      )}
    </div>
  );
}
