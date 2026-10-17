import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from '@nestjs-monorepo-template/ui/components/theme-provider';
import { Toaster } from '@nestjs-monorepo-template/ui/components/sonner';
import '@nestjs-monorepo-template/ui/globals.css';
import { initI18n } from '@/i18n';
import { NotFound } from '@/components/not-found';
import { routeTree } from '@/routeTree.gen';

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  context: { queryClient, session: null },
  defaultNotFoundComponent: NotFound,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const i18n = await initI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <NuqsAdapter>
            <RouterProvider router={router} />
          </NuqsAdapter>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  </StrictMode>,
);
