import { isApiError } from '@nestjs-monorepo-template/api-client';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowLeftIcon } from 'lucide-react';
import type { HeaderContext } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import type { ListColumn } from '@/lib/list-query';
import { DeliveryDialog } from './delivery-dialog';
import {
  EndpointFormDialog,
  type EndpointValues,
} from './endpoint-form-dialog';
import {
  deliveriesPath,
  endpointQuery,
  fromMs,
  useDeleteEndpoint,
  useRetryFailed,
  useRotateSecret,
  useSendTest,
  useUpdateEndpoint,
  type Delivery,
  type Endpoint,
} from './queries';
import { SecretDialog } from './secret-dialog';
import { DeliveryBadge, EndpointBadge } from './status';

/**
 * One endpoint: its settings (edit, switch on or off, test, rotate the
 * secret, delete) and its deliveries, paged, each opening its request and
 * responses; retry one or all that failed.
 */
export function EndpointDetail(props: { clientId: string; id: string }) {
  const { t } = useTranslation('webhooks');
  const read = useQuery({
    ...endpointQuery(props.clientId, props.id),
    meta: { errorToast: false },
  });
  const endpoint = read.data;
  if (read.isPending) {
    return <Spinner />;
  }
  const missing = isApiError(read.error) && read.error.status === 404;
  return (
    <Page>
      <Link
        to="/webhooks/$clientId"
        params={{ clientId: props.clientId }}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'self-start',
        )}
      >
        <ArrowLeftIcon className="rtl:rotate-180" />
        {t('detail.back')}
      </Link>
      {endpoint ? (
        <>
          <PageHeader
            title={<span className="break-all">{endpoint.url}</span>}
            badges={<EndpointBadge endpoint={endpoint} />}
          />
          <SettingsSection clientId={props.clientId} endpoint={endpoint} />
          <DeliveriesSection clientId={props.clientId} endpoint={endpoint} />
        </>
      ) : missing ? (
        <EmptyState title={t('detail.notFound')} />
      ) : (
        <FormAlert message={errorMessage(read.error)} />
      )}
    </Page>
  );
}

function SettingsSection(props: { clientId: string; endpoint: Endpoint }) {
  const { t } = useTranslation('webhooks');
  const { endpoint, clientId } = props;
  const format = useDateTimeFormat();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const update = useUpdateEndpoint(clientId, endpoint.id);
  const rotate = useRotateSecret(clientId, endpoint.id);
  const test = useSendTest(clientId, endpoint.id);
  const remove = useDeleteEndpoint(clientId, endpoint.id);
  const [error, setError] = useState<string>();
  return (
    <Section title={t('detail.title')} description={endpoint.description ?? ''}>
      <FormAlert message={error} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('detail.events')}</dt>
        <dd className="flex flex-wrap gap-1">
          {endpoint.eventTypes.includes('*')
            ? t('endpoints.allEvents')
            : endpoint.eventTypes.map((type) => (
                <code key={type} className="rounded bg-muted px-1 text-xs">
                  {type}
                </code>
              ))}
        </dd>
        <dt className="text-muted-foreground">{t('detail.created')}</dt>
        <dd>{format(fromMs(endpoint.createdAt))}</dd>
        {endpoint.failingSince !== null && (
          <>
            <dt className="text-muted-foreground">
              {t('detail.failingSince')}
            </dt>
            <dd>{format(fromMs(endpoint.failingSince))}</dd>
          </>
        )}
      </dl>
      <Field orientation="horizontal">
        <Switch
          id="endpoint-enabled"
          checked={endpoint.enabled}
          disabled={update.isPending}
          onCheckedChange={async (enabled) => {
            setError(undefined);
            try {
              await update.mutateAsync({ enabled });
              toast.success(
                t(enabled ? 'detail.switchedOn' : 'detail.switchedOff'),
              );
            } catch (caught) {
              setError(errorMessage(caught));
            }
          }}
        />
        <FieldLabel htmlFor="endpoint-enabled">{t('detail.active')}</FieldLabel>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setEditing(true)}>
          {t('detail.edit')}
        </Button>
        <Button
          variant="outline"
          disabled={test.isPending}
          onClick={async () => {
            setError(undefined);
            try {
              await test.mutateAsync();
              toast.success(t('detail.testSent'));
            } catch (caught) {
              setError(errorMessage(caught));
            }
          }}
        >
          {test.isPending && <Spinner />}
          {t('detail.test')}
        </Button>
        <ConfirmButton
          title={t('detail.rotateTitle')}
          description={t('detail.rotateDescription')}
          confirm={t('detail.rotateConfirm')}
          onConfirm={() => rotate.mutateAsync()}
        >
          {t('detail.rotate')}
        </ConfirmButton>
        <ConfirmButton
          variant="destructive"
          title={t('detail.deleteTitle')}
          description={t('detail.deleteDescription')}
          confirm={t('detail.deleteConfirm')}
          onConfirm={async () => {
            await remove.mutateAsync();
            toast.success(t('detail.deleted'));
            await navigate({ to: '/webhooks/$clientId', params: { clientId } });
          }}
        >
          {t('detail.delete')}
        </ConfirmButton>
      </div>
      {editing && (
        <EndpointFormDialog
          open
          onOpenChange={setEditing}
          endpoint={endpoint}
          onSubmit={async (values: EndpointValues) => {
            await update.mutateAsync({
              url: values.url,
              eventTypes: values.eventTypes,
              // null clears it; an empty string is a 400.
              description: values.description || null,
            });
            toast.success(t('form.saved'));
          }}
        />
      )}
      <SecretDialog
        secret={rotate.data?.secret}
        title={t('secret.rotatedTitle')}
        onClose={() => rotate.reset()}
      />
    </Section>
  );
}

/**
 * The endpoint's deliveries on the generic list page: the filters (status,
 * event type, attempts, creation time) and the paging come from
 * `GET /v1/lists/WebhookDelivery`, the client stays in the path and the
 * endpoint is a fixed `endpointId` filter.
 */
function DeliveriesSection(props: { clientId: string; endpoint: Endpoint }) {
  const { t } = useTranslation('webhooks');
  const format = useDateTimeFormat();
  const [open, setOpen] = useState<string>();
  const columns = useMemo<ListColumn<Delivery>[]>(() => {
    const header = (key: string) => {
      const label = t(`deliveries.columns.${key}`);
      return {
        meta: { label },
        header: ({
          column,
        }: HeaderContext<DataTableFeatures, Delivery, unknown>) => (
          <DataTableColumnHeader column={column} label={label} />
        ),
      };
    };
    return [
      {
        id: 'type',
        accessorKey: 'type',
        ...header('type'),
        cell: ({ row }) => (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 font-mono text-xs"
            onClick={() => setOpen(row.original.id)}
          >
            {row.original.type}
          </Button>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        ...header('status'),
        cell: ({ row }) => <DeliveryBadge status={row.original.status} />,
      },
      { id: 'attempts', accessorKey: 'attempts', ...header('attempts') },
      {
        id: 'lastStatusCode',
        accessorKey: 'lastStatusCode',
        ...header('response'),
        cell: ({ row }) => row.original.lastStatusCode ?? '',
      },
      {
        id: 'lastError',
        accessorKey: 'lastError',
        ...header('error'),
        cell: ({ row }) => (
          <span className="block max-w-64 truncate">
            {row.original.lastError ?? ''}
          </span>
        ),
      },
      {
        id: 'createdAt',
        accessorFn: (delivery) => format(delivery.createdAt),
        ...header('created'),
      },
    ];
  }, [t, format]);
  // Only this endpoint's, and none in flight stays unsettled unseen.
  const query = useMemo(
    () => ({ endpointId: props.endpoint.id }),
    [props.endpoint.id],
  );
  const pathParams = useMemo(
    () => ({ clientId: props.clientId }),
    [props.clientId],
  );
  return (
    <div className="flex flex-col gap-4">
      <ListPage
        subject="WebhookDelivery"
        path={deliveriesPath}
        pathParams={pathParams}
        query={query}
        title={t('deliveries.title')}
        subtitle={t('deliveries.description')}
        headingLevel={2}
        columns={columns}
        toolbarActions={
          <RetryFailedButton
            clientId={props.clientId}
            endpointId={props.endpoint.id}
          />
        }
        refetchInterval={settling}
      />
      <DeliveryDialog
        clientId={props.clientId}
        id={open}
        onClose={() => setOpen(undefined)}
      />
    </div>
  );
}

/** A delivery in flight settles on its own: look again until none is. */
const settling = (rows: Delivery[]) =>
  rows.some((row) => row.status === 'pending') ? 3000 : false;

/** Every failed delivery of the endpoint again, optionally since a time. */
function RetryFailedButton(props: { clientId: string; endpointId: string }) {
  const { t } = useTranslation('webhooks');
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState('');
  const retry = useRetryFailed(props.clientId, props.endpointId);
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          // Each retry starts from "everything", not the last one's time.
          setSince('');
          setOpen(true);
        }}
      >
        {t('retryFailed.button')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('retryFailed.title')}</DialogTitle>
            <DialogDescription>
              {t('retryFailed.description')}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="retry-since">
              {t('retryFailed.since')}
            </FieldLabel>
            <Input
              id="retry-since"
              type="datetime-local"
              value={since}
              onChange={(event) => setSince(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('form.cancel')}
            </Button>
            <Button
              disabled={retry.isPending}
              onClick={async () => {
                const result = await retry.mutateAsync(
                  since ? new Date(since).toISOString() : undefined,
                );
                toast.success(t('retryFailed.done', { count: result.retried }));
                setOpen(false);
              }}
            >
              {retry.isPending && <Spinner />}
              {t('retryFailed.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
