import { WebhookIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 42,
  to: '/webhooks',
  label: 'webhooks:nav.title',
  icon: WebhookIcon,
  feature: 'webhooks',
  permission: 'Access.manageClients',
} satisfies NavContribution;
