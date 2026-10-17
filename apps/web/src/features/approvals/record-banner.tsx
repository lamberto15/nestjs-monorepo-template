import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ClipboardCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApprovalActions } from './actions';
import { approvalQuery, recordApprovalQuery } from './api';

/**
 * The open approval of a record, on its page: "Awaiting approval: stage 1
 * of 2", who asked, and the approver's actions. Nothing when the record has
 * none, or the user may not see it (the API answers an empty list).
 */
export function ApprovalBanner(props: { subject: string; recordId: string }) {
  const found = useQuery(recordApprovalQuery(props.subject, props.recordId));
  const id = found.data;
  const detail = useQuery({ ...approvalQuery(id ?? ''), enabled: !!id });
  const { t } = useTranslation('approvals');
  if (!id || !detail.data) {
    return null;
  }
  const { approval, etag } = detail.data;
  return (
    <Alert>
      <ClipboardCheckIcon />
      <AlertTitle>
        {t(
          approval.status === 'changes_requested'
            ? 'banner.changesRequested'
            : 'banner.awaiting',
          {
            current: approval.currentStage + 1,
            count: approval.stageCount,
            name: approval.stageName,
          },
        )}
      </AlertTitle>
      <AlertDescription>
        <p>
          {t('banner.requestedBy', { name: approval.requesterName })} ·{' '}
          <Link
            to="/approvals/$id"
            params={{ id: approval.id }}
            className="underline underline-offset-4"
          >
            {t('banner.details')}
          </Link>
        </p>
        <div className="mt-2">
          <ApprovalActions approval={approval} etag={etag} />
        </div>
      </AlertDescription>
    </Alert>
  );
}
