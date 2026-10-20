import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCan, useMe } from '@/lib/features';
import type { ApprovalItem } from './api';
import { DecisionDialog, type DecisionTarget } from './decision-dialog';

/**
 * What the user may do with a request now, sent with `If-Match: <etag>` (a
 * request's page and the inbox's rows both carry `can` and the ETag):
 *
 * - approve, reject, and ask for changes (`can.decide`: the approver);
 * - resubmit (`can.resubmit`: the requester, after changes were asked);
 * - cancel (`can.cancel`);
 * - abandon: `Approval.manage`, for an approved request whose outcome was
 *   never applied. The API has no `can` for it (it refuses a request whose
 *   workflow still runs or retries, 409 `approval_not_stuck`, and the
 *   dialog says so), so the button follows the permission and the request's
 *   state.
 *
 * Nothing while acting as someone else: the API refuses it (403
 * `approval_impersonation`).
 */
export function ApprovalActions(props: {
  approval: Pick<
    ApprovalItem,
    'id' | 'title' | 'can' | 'status' | 'outcomeAppliedAt'
  >;
  etag?: string;
}) {
  const { t } = useTranslation('approvals');
  const impersonating = !!useMe()?.user.impersonator;
  const manages = useCan('Approval.manage');
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
  const { decide, cancel, resubmit } = approval.can;
  const abandon =
    manages && approval.status === 'approved' && !approval.outcomeAppliedAt;
  if (!decide && !cancel && !resubmit && !abandon) {
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
            <Button
              size="sm"
              variant="outline"
              onClick={() => open('requestChanges')}
            >
              {t('decision.requestChanges.button')}
            </Button>
          </>
        )}
        {resubmit && (
          <Button size="sm" onClick={() => open('resubmit')}>
            {t('decision.resubmit.button')}
          </Button>
        )}
        {cancel && (
          <Button size="sm" variant="ghost" onClick={() => open('cancel')}>
            {t('decision.cancel.button')}
          </Button>
        )}
        {abandon && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => open('abandon')}
          >
            {t('decision.abandon.button')}
          </Button>
        )}
      </div>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
