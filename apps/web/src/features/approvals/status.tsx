import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { useTranslation } from 'react-i18next';
import type { ApprovalStatus } from './api';

const variants: Record<
  ApprovalStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'secondary',
  changes_requested: 'secondary',
  approved: 'default',
  rejected: 'destructive',
  cancelled: 'outline',
  expired: 'outline',
  failed: 'destructive',
};

export function StatusBadge(props: { status: ApprovalStatus }) {
  const { t } = useTranslation('approvals');
  return (
    <Badge variant={variants[props.status]}>
      {t(`status.${props.status}`)}
    </Badge>
  );
}
