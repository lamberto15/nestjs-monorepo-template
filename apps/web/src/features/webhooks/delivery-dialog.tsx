import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { deliveryQuery, prettyPayload, useRetryDelivery } from './queries';
import { DeliveryBadge } from './status';

/** A block of text a remote system sent or received: text, never markup. */
function Raw(props: { label: string; children: string }) {
  return (
    <pre
      aria-label={props.label}
      className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap"
    >
      {props.children}
    </pre>
  );
}

/**
 * One delivery: the request (headers as sent, the payload that was signed)
 * and what came back for every attempt. The payload and the responses are
 * the sender's and the receiver's text: rendered as text, nothing parsed
 * into elements.
 */
export function DeliveryDialog(props: {
  clientId: string;
  id: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('webhooks');
  const format = useDateTimeFormat();
  const read = useQuery({
    ...deliveryQuery(props.clientId, props.id ?? ''),
    enabled: props.id !== undefined,
  });
  const retry = useRetryDelivery(props.clientId);
  const delivery = read.data;
  return (
    <Dialog
      open={props.id !== undefined}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('delivery.title')}</DialogTitle>
          <DialogDescription>
            {delivery ? delivery.type : t('delivery.loading')}
          </DialogDescription>
        </DialogHeader>
        {read.isError ? (
          <FormAlert message={errorMessage(read.error)} />
        ) : !delivery ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t('delivery.state')}</dt>
              <dd>
                <DeliveryBadge status={delivery.status} />
              </dd>
              <dt className="text-muted-foreground">
                {t('delivery.messageId')}
              </dt>
              <dd className="font-mono text-xs break-all">
                {delivery.messageId}
              </dd>
              <dt className="text-muted-foreground">
                {t('delivery.attempts')}
              </dt>
              <dd>{delivery.attempts}</dd>
              <dt className="text-muted-foreground">
                {t('delivery.duration')}
              </dt>
              <dd>{t('delivery.ms', { ms: delivery.durationMs })}</dd>
              <dt className="text-muted-foreground">{t('delivery.created')}</dt>
              <dd>{format(delivery.createdAt)}</dd>
              {delivery.failureReason && (
                <>
                  <dt className="text-muted-foreground">
                    {t('delivery.failure')}
                  </dt>
                  <dd>{t(`delivery.reasons.${delivery.failureReason}`)}</dd>
                </>
              )}
              {delivery.lastError && (
                <>
                  <dt className="text-muted-foreground">
                    {t('delivery.lastError')}
                  </dt>
                  <dd className="break-all">{delivery.lastError}</dd>
                </>
              )}
            </dl>

            <section className="flex flex-col gap-2">
              <h3 className="font-medium">{t('delivery.request')}</h3>
              {delivery.lastRequest ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t('delivery.sentAt', {
                      attempt: delivery.lastRequest.attempt,
                      date: format(delivery.lastRequest.sentAt),
                    })}
                  </p>
                  <Raw label={t('delivery.headers')}>
                    {Object.entries(delivery.lastRequest.headers)
                      .map(([name, value]) => `${name}: ${value}`)
                      .join('\n')}
                  </Raw>
                </>
              ) : (
                <p className="text-muted-foreground">{t('delivery.notSent')}</p>
              )}
              <Raw label={t('delivery.payload')}>
                {prettyPayload(delivery.message.body)}
              </Raw>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-medium">{t('delivery.responses')}</h3>
              {delivery.history.length ? (
                delivery.history.map((attempt) => (
                  <div
                    key={attempt.attempt + ':' + attempt.at}
                    className="flex flex-col gap-1 rounded-md border p-3"
                  >
                    <p className="text-xs text-muted-foreground">
                      {t('delivery.attemptLine', {
                        attempt: attempt.attempt,
                        date: format(attempt.at),
                        status: attempt.statusCode ?? t('delivery.noStatus'),
                        ms: attempt.durationMs,
                      })}
                    </p>
                    {attempt.error && (
                      <p className="break-all text-destructive">
                        {attempt.error}
                      </p>
                    )}
                    {attempt.response ? (
                      <Raw
                        label={t('delivery.responseBody', {
                          attempt: attempt.attempt,
                        })}
                      >
                        {attempt.response}
                      </Raw>
                    ) : (
                      <p className="text-muted-foreground">
                        {t('delivery.noBody')}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">
                  {t('delivery.noAttempts')}
                </p>
              )}
            </section>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            {t('delivery.close')}
          </Button>
          {delivery && delivery.status !== 'pending' && (
            <Button
              type="button"
              disabled={retry.isPending}
              onClick={async () => {
                await retry.mutateAsync(delivery.id);
                toast.success(t('delivery.retried'));
              }}
            >
              {t('delivery.retry')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
