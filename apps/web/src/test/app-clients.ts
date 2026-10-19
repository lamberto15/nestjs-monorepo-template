import type { QueryClient } from '@tanstack/react-query';

// The query clients of the apps a test rendered (renderApp). A test may end
// while one still has work in flight: a navigation's fetch, or a result whose
// update TanStack Query has scheduled on a timer. Left alone, that work runs
// after the test's environment is torn down (`window is not defined`, an
// unhandled error that fails the run). setup.ts hands them to teardownApps.
const clients = new Set<QueryClient>();

export function trackClient(client: QueryClient) {
  clients.add(client);
}

/**
 * Stops every tracked client's work (TanStack Query's testing guide: one
 * client per test, cleared after it): in-flight queries are cancelled and the
 * cache emptied, then one macrotask passes so an update already scheduled
 * runs while the environment still exists, against nothing mounted.
 */
export async function teardownApps() {
  for (const client of clients) {
    await client.cancelQueries();
    client.getMutationCache().clear();
    client.clear();
  }
  clients.clear();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
