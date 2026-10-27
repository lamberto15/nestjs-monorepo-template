import type { QueryClient } from '@tanstack/react-query';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';
import { PageTitle, RouteFocus } from '@/components/route-accessibility';
import type { Session } from '@/lib/session';

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  session: Session;
}>()({
  component: Root,
});

function Root() {
  return (
    <>
      <PageTitle />
      <RouteFocus />
      {/* Inside the router, as nuqs documents it: the adapter reads the
          router's history (useRouter), so it can't wrap <RouterProvider>. */}
      <NuqsAdapter>
        <Outlet />
      </NuqsAdapter>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools />
          <ReactQueryDevtools buttonPosition="bottom-left" />
        </>
      )}
    </>
  );
}
