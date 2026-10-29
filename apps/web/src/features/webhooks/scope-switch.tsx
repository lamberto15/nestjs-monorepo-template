import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { scopeQuery, useSetScope } from './queries';

/**
 * The client's subscriber scope (docs/webhooks-and-realtime.md, "Subscriber
 * scope"): off, only its own records' events; on, also its tenant's records
 * it may read, without the fields it may not.
 */
export function ScopeSwitch(props: { clientId: string }) {
  const { t } = useTranslation('webhooks');
  const id = useId();
  const scope = useQuery({
    ...scopeQuery(props.clientId),
    meta: { errorToast: false },
  });
  const set = useSetScope(props.clientId);
  if (!scope.data) {
    return null;
  }
  return (
    <Field orientation="horizontal">
      <Switch
        id={id}
        checked={scope.data.scope === 'tenant'}
        disabled={set.isPending}
        onCheckedChange={(on) =>
          set.mutate(on ? 'tenant' : 'own', {
            onSuccess: () => toast.success(t('scope.saved')),
          })
        }
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{t('scope.label')}</FieldLabel>
        <FieldDescription>{t('scope.description')}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
