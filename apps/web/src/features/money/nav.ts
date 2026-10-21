import { CoinsIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 360,
  to: '/exchange-rates',
  label: 'money:nav',
  icon: CoinsIcon,
  feature: 'exchangeRates',
} satisfies NavContribution;
