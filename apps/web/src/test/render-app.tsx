import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resourcesFrom } from '@/i18n';
import { App, createApp } from '@/app';
import { featuresQuery, meQuery } from '@/lib/session';

/** The whole app (every provider, the router, the error handler) at a path. */
export async function renderApp(path: string) {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: resourcesFrom(
      import.meta.glob<Record<string, unknown>>('@/locales/en/*.json', {
        eager: true,
        import: 'default',
      }),
    ),
    defaultNS: 'common',
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const { queryClient, router } = createApp(history);
  // A test's queries fail fast and visibly (TanStack Query's testing guide):
  // the app's retry of a 5xx would wait seconds before the page shows the error.
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  // What the first screen waits for is awaited here, on the test's own
  // timeout, not inside the first findBy (one second): the first navigation
  // (the route guards' fetch of the session) and, signed in, the switches
  // every layout gates on. A cold first test on a busy machine takes longer.
  await router.load();
  if (queryClient.getQueryData(meQuery.queryKey)) {
    await queryClient.prefetchQuery(featuresQuery);
  }
  render(<App router={router} queryClient={queryClient} i18n={i18n} />);
  return { router, queryClient, history };
}
