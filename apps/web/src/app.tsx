import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
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
import { ReauthDialog } from '@/components/reauth-dialog';
import { RouteError } from '@/components/route-error';
import { createQueryClient } from '@/lib/errors';
import { createSession } from '@/lib/session';
import { routeTree } from '@/routeTree.gen';

/** The router; a test passes a memory history. */
export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient, session: createSession(queryClient) },
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: RouteError,
    defaultPreload: 'intent',
    ...(history && { history }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

/**
 * The query client and the router, wired together: the global error handler
 * (lib/errors.ts) sends a user whose session ended to sign-in, back to the
 * page they were on afterwards.
 */
export function createApp(history?: RouterHistory) {
  let router: AppRouter | undefined;
  const queryClient = createQueryClient(() => {
    const current = router;
    return (
      current && {
        currentHref: () => current.state.location.href,
        inApp: () =>
          current.state.matches.some((match) => match.routeId === '/_app'),
        toSignIn: (redirect) =>
          void current.navigate({ to: '/sign-in', search: { redirect } }),
        toMfaSetup: () => {
          if (current.state.location.pathname !== '/account/security') {
            void current.navigate({ to: '/account/security' });
          }
        },
      }
    );
  });
  router = createAppRouter(queryClient, history);
  return { queryClient, router };
}

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
          <ReauthDialog />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
