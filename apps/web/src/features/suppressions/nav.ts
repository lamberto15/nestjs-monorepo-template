import { MailXIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'operators',
  order: 20,
  to: '/mail-suppressions',
  label: 'suppressions:nav',
  icon: MailXIcon,
  permission: 'MailSuppression.view',
  operatorTenant: true,
} satisfies NavContribution;
