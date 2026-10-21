import { createFileRoute } from '@tanstack/react-router';
import { requireFeature } from '@/features/api-clients/gate';
import { ExchangeRatesPage } from '@/features/money/exchange-rates-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/exchange-rates')({
  beforeLoad: requireFeature('exchangeRates'),
  component: ExchangeRatesPage,
});
