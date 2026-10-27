import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  RouterProvider,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { DirectionProvider } from '@nestjs-monorepo-template/ui/components/direction';
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
    // Back and forward come back to where the page was scrolled (a new
    // page starts at the top either way).
    scrollRestoration: true,
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
        toOnboarding: () => {
          if (current.state.location.pathname !== '/onboarding') {
            void current.navigate({ to: '/onboarding' });
          }
        },
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
  interface StaticDataRouteOption {
    /**
     * The i18n key of the page's name in the document title (`PageTitle`),
     * for a page the menu does not list.
     */
    title?: string;
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
        <LanguageDirection>
          <QueryClientProvider client={props.queryClient}>
            <RouterProvider router={props.router} />
            <ReauthDialog />
            <Toaster />
          </QueryClientProvider>
        </LanguageDirection>
      </ThemeProvider>
    </I18nextProvider>
  );
}

/**
 * The language's direction for Base UI's components (menus, popovers,
 * selects, sliders, and the data tables that copy it into `dir`): they read
 * its DirectionProvider, never `<html dir>`, and are left to right without
 * one. Inside the i18n provider, so a change of language re-renders it.
 */
export function LanguageDirection(props: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <DirectionProvider direction={i18n.dir()}>
      {props.children}
    </DirectionProvider>
  );
}
