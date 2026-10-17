import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/lib/features';
import type { Approval } from './api';
import { DecisionDialog, type DecisionTarget } from './decision-dialog';

/**
 * What the user may do with a request now: approve or reject (`can.decide`),
 * cancel (`can.cancel`). Nothing while acting as someone else: the API
 * refuses it (403 `approval_impersonation`).
 */
export function ApprovalActions(props: { approval: Approval; etag?: string }) {
  const { t } = useTranslation('approvals');
  const impersonating = !!useMe()?.user.impersonator;
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  const { approval } = props;
  const open = (decision: DecisionTarget['decision']) =>
    setTarget({
      id: approval.id,
      title: approval.title,
      decision,
      etag: props.etag,
    });
  if (impersonating) {
    return null;
  }
  const { decide, cancel } = approval.can;
  if (!decide && !cancel) {
    return null;
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {decide && (
          <>
            <Button size="sm" onClick={() => open('approve')}>
              {t('decision.approve.button')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => open('reject')}>
              {t('decision.reject.button')}
            </Button>
          </>
        )}
        {cancel && (
          <Button size="sm" variant="ghost" onClick={() => open('cancel')}>
            {t('decision.cancel.button')}
          </Button>
        )}
      </div>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
