import { useQuery } from '@tanstack/react-query';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
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
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/date-time';
import { CreateClientDialog } from './create-client-dialog';
import { activeKeys, clientsQuery, lastUsed, useCreateClient } from './queries';
import { SecretDialog } from './secret-dialog';

/** The API clients; creating one shows its key, once. */
export function ClientsPage() {
  const { t } = useTranslation('api-clients');
  const list = useQuery(clientsQuery);
  const [creating, setCreating] = useState(false);
  const create = useCreateClient();
  return (
    <Page>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            {t('list.create')}
          </Button>
        }
      />
      {list.isPending ? (
        <Spinner />
      ) : list.data?.items.length ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('list.columns.name')}</TableHead>
                <TableHead>{t('list.columns.status')}</TableHead>
                <TableHead>{t('list.columns.quota')}</TableHead>
                <TableHead>{t('list.columns.keys')}</TableHead>
                <TableHead>{t('list.columns.lastUsed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/api-clients/$id"
                      params={{ id: client.id }}
                      className="underline-offset-4 hover:underline"
                    >
                      {client.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={client.active ? 'default' : 'outline'}>
                      {t(`status.${client.active ? 'active' : 'revoked'}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {client.dailyQuota?.toLocaleString() ?? t('list.noQuota')}
                  </TableCell>
                  <TableCell>{activeKeys(client).length}</TableCell>
                  <TableCell>
                    {formatDateTime(lastUsed(client)) || t('list.never')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title={t('list.empty')} />
      )}
      <CreateClientDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={(input) => create.mutateAsync(input)}
      />
      <SecretDialog
        secret={create.data?.key}
        title={t('secret.createdTitle', { name: create.data?.name ?? '' })}
        onClose={() => create.reset()}
      />
    </Page>
  );
}
