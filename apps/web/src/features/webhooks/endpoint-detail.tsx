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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { DeliveryDialog } from './delivery-dialog';
import {
  EndpointFormDialog,
  type EndpointValues,
} from './endpoint-form-dialog';
import {
  deliveriesQuery,
  endpointQuery,
  fromMs,
  useDeleteEndpoint,
  useRetryFailed,
  useRotateSecret,
  useSendTest,
  useUpdateEndpoint,
  type DeliveryStatus,
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
    <div className="flex max-w-4xl flex-col gap-4">
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
          <SettingsSection clientId={props.clientId} endpoint={endpoint} />
          <DeliveriesSection clientId={props.clientId} endpoint={endpoint} />
        </>
      ) : missing ? (
        <p className="text-sm text-muted-foreground">{t('detail.notFound')}</p>
      ) : (
        <FormAlert message={errorMessage(read.error)} />
      )}
    </div>
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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-medium break-all">{endpoint.url}</h1>
        <EndpointBadge endpoint={endpoint} />
      </div>
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

const ALL = 'all';

function DeliveriesSection(props: { clientId: string; endpoint: Endpoint }) {
  const { t } = useTranslation('webhooks');
  const format = useDateTimeFormat();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<DeliveryStatus | undefined>();
  const [open, setOpen] = useState<string>();
  const list = useQuery({
    ...deliveriesQuery(props.clientId, props.endpoint.id, page, status),
    meta: { errorToast: false },
  });
  const pageCount = list.data?.pageCount ?? 1;
  return (
    <Section
      title={t('deliveries.title')}
      description={t('deliveries.description')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-48">
          <FieldLabel htmlFor="delivery-status">
            {t('deliveries.filter')}
          </FieldLabel>
          <Select
            value={status ?? ALL}
            onValueChange={(value) => {
              setPage(1);
              setStatus(value === ALL ? undefined : (value as DeliveryStatus));
            }}
          >
            <SelectTrigger id="delivery-status">
              <SelectValue>
                {(value: string) =>
                  value === ALL
                    ? t('deliveries.all')
                    : t(`delivery.status.${value as DeliveryStatus}`)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('deliveries.all')}</SelectItem>
              {(['pending', 'succeeded', 'failed'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`delivery.status.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <RetryFailedButton
          clientId={props.clientId}
          endpointId={props.endpoint.id}
        />
      </div>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <FormAlert message={errorMessage(list.error)} />
      ) : list.data.items.length ? (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('deliveries.columns.type')}</TableHead>
                  <TableHead>{t('deliveries.columns.status')}</TableHead>
                  <TableHead>{t('deliveries.columns.attempts')}</TableHead>
                  <TableHead>{t('deliveries.columns.response')}</TableHead>
                  <TableHead>{t('deliveries.columns.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell className="font-mono text-xs">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 font-mono text-xs"
                        onClick={() => setOpen(delivery.id)}
                      >
                        {delivery.type}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <DeliveryBadge status={delivery.status} />
                    </TableCell>
                    <TableCell>{delivery.attempts}</TableCell>
                    <TableCell>
                      {delivery.lastStatusCode ?? delivery.lastError ?? ''}
                    </TableCell>
                    <TableCell>{format(fromMs(delivery.createdAt))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {t('deliveries.page', { page, count: pageCount })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('deliveries.previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!list.data.nextPage}
                onClick={() => setPage(page + 1)}
              >
                {t('deliveries.next')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('deliveries.empty')}</p>
      )}
      <DeliveryDialog
        clientId={props.clientId}
        id={open}
        onClose={() => setOpen(undefined)}
      />
    </Section>
  );
}

/** Every failed delivery of the endpoint again, optionally since a time. */
function RetryFailedButton(props: { clientId: string; endpointId: string }) {
  const { t } = useTranslation('webhooks');
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState('');
  const retry = useRetryFailed(props.clientId, props.endpointId);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
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
