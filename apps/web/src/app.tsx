import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import type { i18n as I18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from '@nestjs-monorepo-template/ui/components/theme-provider';
import { Toaster } from '@nestjs-monorepo-template/ui/components/sonner';
import { NotFound } from '@/components/not-found';
import { routeTree } from '@/routeTree.gen';

/** The router; a test passes a memory history. */
export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient, session: null },
    defaultNotFoundComponent: NotFound,
    defaultPreload: 'intent',
    ...(history && { history }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

/**
 * Every provider, in one place that main.tsx and the app test share. A
 * provider that needs the router (nuqs's adapter) goes in the root route
 * (routes/__root.tsx), never around RouterProvider.
 */
export function App(props: {
  router: AppRouter;
  queryClient: QueryClient;
  i18n: I18n;
}) {
  return (
    <I18nextProvider i18n={props.i18n}>
      <ThemeProvider>
        <QueryClientProvider client={props.queryClient}>
          <RouterProvider router={props.router} />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
