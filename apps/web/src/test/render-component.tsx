import { QueryClientProvider } from '@tanstack/react-query';
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
import { meQuery, type Me } from '@/lib/session';
import { signedInUser } from '@/test/server';

/**
 * One component with what the app gives it (the texts, the query client
 * with its error toasts, a router for its links, the signed-in user with
 * these permissions), without a page around it. For shared components a
 * feature's page would host: their tests then need no feature's routes,
 * and stand when `pnpm feature:remove` takes that feature (a test-only
 * subject, as the API's tests use TestItem).
 */
export async function renderComponent(
  ui: ReactNode,
  options: { can?: readonly string[] } = {},
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
  });
  const queryClient = createQueryClient(() => undefined);
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  const me: Me = {
    ...signedInUser,
    can: Object.fromEntries((options.can ?? []).map((p) => [p, true])),
  };
  queryClient.setQueryData(meQuery.queryKey, me);
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
