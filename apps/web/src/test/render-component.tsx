import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Toaster } from '@nestjs-monorepo-template/ui/components/sonner';
import { ThemeProvider } from '@nestjs-monorepo-template/ui/components/theme-provider';
import { resourcesFrom } from '@/i18n';
import { createQueryClient } from '@/lib/errors';
import { featuresQuery, meQuery, type Features, type Me } from '@/lib/session';
import { allFeatures, signedInUser } from '@/test/server';
import { trackClient } from '@/test/app-clients';
import { missingKeyOptions } from '@/test/i18n';

/**
 * One component with what the app gives it (the texts, the query client
 * with its error toasts, a router for its links, the signed-in user with
 * these permissions, and the deployment's switches when `features` says what
 * differs from `allFeatures`), without a page around it. For shared components a
 * feature's page would host: their tests then need no feature's routes,
 * and stand when `pnpm feature:remove` takes that feature (a test-only
 * subject, as the API's tests use TestItem).
 */
export async function renderComponent(
  ui: ReactNode,
  options: {
    can?: readonly string[];
    /** The switches `GET /v1/features` gave, over `allFeatures`: none given, none known. */
    features?: Partial<Features>;
    /** An isolated cache for component tests that do not mount the session watcher. */
    queryClient?: QueryClient;
  } = {},
) {
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
    // A key no catalog has fails the test (test/i18n.ts).
    ...missingKeyOptions,
  });
  const queryClient = options.queryClient ?? createQueryClient(() => undefined);
  trackClient(queryClient);
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  const me: Me = {
    ...signedInUser,
    can: Object.fromEntries((options.can ?? []).map((p) => [p, true])),
  };
  queryClient.setQueryData(meQuery.queryKey, me);
  if (options.features) {
    queryClient.setQueryData(featuresQuery.queryKey, {
      ...allFeatures,
      ...options.features,
    });
  }
  // A router of one route that shows the component: a Link inside it
  // builds its href as in the app.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
  return { ...view, queryClient };
}
