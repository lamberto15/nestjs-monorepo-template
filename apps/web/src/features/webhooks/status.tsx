import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { useTranslation } from 'react-i18next';
import type { DeliveryStatus, Endpoint } from './queries';

/** A delivery's state; the colours say it at a glance, the words always. */
export function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation('webhooks');
  return (
    <Badge
      variant={
        status === 'failed'
          ? 'destructive'
          : status === 'pending'
            ? 'outline'
            : 'default'
      }
    >
      {t(`delivery.status.${status}`)}
    </Badge>
  );
}

/** Whether an endpoint receives events, and if not, why. */
export function EndpointBadge({ endpoint }: { endpoint: Endpoint }) {
  const { t } = useTranslation('webhooks');
  if (endpoint.enabled) {
    return <Badge>{t('endpoint.enabled')}</Badge>;
  }
  return (
    <Badge variant="outline">
      {t(`endpoint.disabled.${endpoint.disabledReason ?? 'manual'}`)}
    </Badge>
  );
}
