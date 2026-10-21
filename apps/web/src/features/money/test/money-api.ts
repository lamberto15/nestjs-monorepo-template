import { http, HttpResponse } from 'msw/http';
import { allFeatures, problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

// The money routes in memory (msw): the rates of a day (404 when none) and a
// conversion at a fixed rate, recording what the page asked.

export function useMoneyApi(
  options: {
    exchangeRates?: boolean;
    rates?: Record<string, string> | null;
  } = {},
) {
  const calls = {
    rates: [] as (string | null)[],
    convert: [] as URLSearchParams[],
  };
  const rates =
    options.rates === undefined
      ? { USD: '1.1652', JPY: '181.5', GBP: '0.8721' }
      : options.rates;
  useSignedIn([]);
  server.use(
    http.get('/v1/features', () =>
      HttpResponse.json({
        ...allFeatures,
        realtime: false,
        exchangeRates: options.exchangeRates ?? true,
      }),
    ),
    http.get('/v1/money/rates', ({ request }) => {
      calls.rates.push(new URL(request.url).searchParams.get('date'));
      return rates === null
        ? problem(404, 'rates_unavailable')
        : HttpResponse.json({
            source: 'ecb',
            base: 'EUR',
            day: '2026-10-20',
            rates,
          });
    }),
    http.get('/v1/money/convert', ({ request }) => {
      const query = new URL(request.url).searchParams;
      calls.convert.push(query);
      return HttpResponse.json({
        from: { amount: query.get('amount'), currency: query.get('currency') },
        amount: { amount: '1165.20', currency: query.get('to') },
        rate: '116.52',
        rateDate: '2026-10-20',
        source: 'ecb',
        base: 'EUR',
        legs: { from: '1', to: '116.52' },
        rounding: 'half-up',
      });
    }),
  );
  return { calls };
}
