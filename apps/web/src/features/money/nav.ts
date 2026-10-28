import { CoinsIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 70,
  to: '/exchange-rates',
  label: 'money:nav',
  icon: CoinsIcon,
  feature: 'exchangeRates',
} satisfies NavContribution;
