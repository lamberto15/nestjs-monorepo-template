import { isApiError } from '@nestjs-monorepo-template/api-client';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowLeftIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clientQuery } from '@/features/api-clients/queries';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import {
  EndpointFormDialog,
  type EndpointValues,
} from './endpoint-form-dialog';
import { endpointsQuery, useCreateEndpoint } from './queries';
import { SecretDialog } from './secret-dialog';
import { EndpointBadge } from './status';

/** One client's endpoints; creating one shows its secret, once. */
export function EndpointsPage(props: { clientId: string }) {
  const { t } = useTranslation('webhooks');
  const client = useQuery({
    ...clientQuery(props.clientId),
    meta: { errorToast: false },
  });
  const list = useQuery({
    ...endpointsQuery(props.clientId),
    meta: { errorToast: false },
  });
  const [creating, setCreating] = useState(false);
  const create = useCreateEndpoint(props.clientId);
  const submit = (values: EndpointValues) =>
    create.mutateAsync({
      url: values.url,
      eventTypes: values.eventTypes,
      // An empty description is a 400: leave it out.
      ...(values.description && { description: values.description }),
    });
  const missing =
    (isApiError(client.error) && client.error.status === 404) ||
    (isApiError(list.error) && list.error.status === 404);
  return (
    <Page>
      <Link
        to="/webhooks"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'self-start',
        )}
      >
        <ArrowLeftIcon className="rtl:rotate-180" />
        {t('endpoints.back')}
      </Link>
      {missing ? (
        <EmptyState title={t('endpoints.notFound')} />
      ) : (
        <>
          <PageHeader
            title={t('endpoints.title', { client: client.data?.name ?? '' })}
            description={t('endpoints.description')}
            actions={
              <Button onClick={() => setCreating(true)}>
                <PlusIcon />
                {t('endpoints.create')}
              </Button>
            }
          />
          {list.isPending ? (
            <Spinner />
          ) : list.isError ? (
            <FormAlert message={errorMessage(list.error)} />
          ) : list.data.items.length ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('endpoints.columns.url')}</TableHead>
                    <TableHead>{t('endpoints.columns.status')}</TableHead>
                    <TableHead>{t('endpoints.columns.events')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.items.map((endpoint) => (
                    <TableRow key={endpoint.id}>
                      <TableCell className="max-w-md font-medium">
                        <Link
                          to="/webhooks/$clientId/$id"
                          params={{ clientId: props.clientId, id: endpoint.id }}
                          className="break-all underline-offset-4 hover:underline"
                        >
                          {endpoint.url}
                        </Link>
                        {endpoint.description && (
                          <p className="text-xs font-normal text-muted-foreground">
                            {endpoint.description}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <EndpointBadge endpoint={endpoint} />
                      </TableCell>
                      <TableCell>
                        {endpoint.eventTypes.includes('*')
                          ? t('endpoints.allEvents')
                          : t('endpoints.eventCount', {
                              count: endpoint.eventTypes.length,
                            })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title={t('endpoints.empty')} />
          )}
        </>
      )}
      {/* Mounted only while open: a cancelled draft doesn't come back. */}
      {creating && (
        <EndpointFormDialog open onOpenChange={setCreating} onSubmit={submit} />
      )}
      <SecretDialog
        secret={create.data?.secret}
        title={t('secret.createdTitle')}
        onClose={() => create.reset()}
      />
    </Page>
  );
}
