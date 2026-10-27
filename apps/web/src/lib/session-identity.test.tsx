import { QueryObserver, type QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CreateClientBody } from '@/features/api-clients/queries';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/errors';
import { requestReauthentication } from '@/lib/reauth';
import { recordKeys } from '@/lib/records';
import { announceSessionIdentity } from '@/lib/session-bus';
import {
  createSession,
  meQuery,
  sessionIdentity,
  sessionWatch,
  type Me,
} from '@/lib/session';
import { trackClient } from '@/test/app-clients';
import { renderApp } from '@/test/render-app';
import { problem, server, signedInUser } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

/**
 * Issue #555: a session's identity changes — a tenant switch, another
 * account, an impersonation — and the query caches of THIS tab (or of a tab
 * whose shared cookie another tab re-issued) keep the previous context's
 * data. What is established here: a refetch of `me` (or another tab's
 * announcement of the new identity) forgets the old context's queries,
 * mutations and in-flight work before anything of it is shown or submitted
 * again, and an unchanged identity changes nothing.
 */

const otherTenantId = '0199a3f2-0000-7000-8000-00000000002a';
const otherUserId = '0199a3f2-0000-7000-8000-00000000000b';
const recordKey = recordKeys.detail('/v1/tags', 'tag-a');

/** The signed-in `me`: this account, in tenant `tenantId`. */
const meInTenant = (tenantId: string) =>
  ({
    ...signedInUser,
    tenant: {
      ...signedInUser.tenant!,
      id: tenantId,
      slug: 'globex',
      name: 'Globex',
    },
    can: {},
  }) satisfies Me;

/** The signed-in `me`: another account of the same tenant (no tenant). */
const otherUserMe: Me = {
  ...signedInUser,
  user: { ...signedInUser.user, id: otherUserId, name: 'Grace Hopper' },
  can: {},
};

/** The signed-in `me`: this account impersonating another one. */
const impersonatingMe: Me = {
  ...signedInUser,
  user: {
    ...signedInUser.user,
    id: otherUserId,
    email: 'grace@example.com',
    name: 'Grace Hopper',
    impersonator: {
      id: signedInUser.user.id,
      email: signedInUser.user.email,
    },
  },
  can: {},
};

/** Where the router's error handler would send a signed-out page. */
const target = () => ({
  currentHref: () => '/notifications',
  inApp: () => true,
  toSignIn: vi.fn(),
  toMfaSetup: vi.fn(),
  toOnboarding: vi.fn(),
  invalidate: vi.fn(),
});

/**
 * A query client with the real session watcher on it, signed in as `me`,
 * and cache and mutation entries of its own (the previous context's data).
 */
const watchedClient = async (me: Me) => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(me)));
  const to = target();
  const queryClient = createQueryClient(() => to);
  // A watcher lives as long as its client's bus listener does (session-bus's
  // listener registry is module state): teardownApps (setup.ts) clears the
  // client after the test, so a later test's announcements reach nothing
  // (`watchSession` skips a client whose `me` was never read or is gone).
  trackClient(queryClient);
  await queryClient.fetchQuery(meQuery);
  queryClient.setQueryData(recordKey, {
    id: 'tag-a',
    title: 'Old tenant note',
  });
  queryClient.setQueryData(['orphan'], 'old tenant');
  await queryClient
    .getMutationCache()
    .build(queryClient, {
      mutationFn: async () => 'saved under the old session',
    })
    .execute(undefined);
  return { to, queryClient };
};

/** What the session's `me` answers as after this (the re-issued cookie). */
const meAfter = (me: Me) =>
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(me)));

const notifications = (title: string) =>
  server.use(
    http.get('/v1/notifications', () =>
      HttpResponse.json({
        items: [
          {
            id: 'n1',
            type: 'comment.mentioned',
            title,
            body: 'Maya mentioned you.',
            data: {},
            link: null,
            key: null,
            count: 1,
            read: false,
            readAt: null,
            createdAt: '2026-10-17T08:00:00.000Z',
            updatedAt: '2026-10-17T08:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    ),
  );

/**
 * A `me` refetch of the test's own (a window focus's): `fetchQuery` would
 * answer the cache while it is still fresh, so the staleness is forced,
 * which errors.test.ts does as well.
 */
const fetchMe = (queryClient: QueryClient) =>
  queryClient.fetchQuery({ ...meQuery, staleTime: 0 });

/**
 * jsdom has no BroadcastChannel; a fake stands in for the delivery so the
 * tests can exercise what another tab's announcement reaches this one as.
 * It delivers within this document (the receiving side here stands for the
 * other tabs' channels; the standard only-channels-other-tabs part of it —
 * what reaches a tab and when — is a browser behavior, covered by the
 * two-tab browser test in apps/web-e2e).
 *
 * The fake and its channels live for the whole file: the session bus keeps
 * its one channel for the page's life (session-bus.ts), so an announcement
 * made through a later registration still rides the first channel. A test's
 * channels dropping out of the loop would silently cut the next tests' bus
 * off. Stale watchers stay silent across tests: teardownApps (setup.ts)
 * clears their clients, and a watcher whose `me` was never read or is gone
 * does nothing (lib/errors.ts).
 */
type FakeChannel = {
  name: string;
  onmessage: ((event: { data: string | null }) => void) | null;
  postMessage(message: string | null): void;
  close(): void;
};

const channels: FakeChannel[] = [];

beforeAll(() => {
  class FakeBroadcastChannel implements FakeChannel {
    name: string;
    onmessage: FakeChannel['onmessage'] = null;
    constructor(name: string) {
      this.name = name;
      channels.push(this);
    }
    postMessage(message: string | null) {
      for (const other of channels) {
        other.onmessage?.({ data: message });
      }
    }
    close() {}
  }
  (globalThis as { BroadcastChannel: unknown }).BroadcastChannel =
    FakeBroadcastChannel;
});

afterAll(() => {
  delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
});

describe('sessionIdentity', () => {
  it('names who, in which tenant, acting as whom', () => {
    expect(sessionIdentity(signedInUser)).toBe(
      [
        signedInUser.user.id,
        signedInUser.tenant!.id,
        signedInUser.user.impersonator?.id ?? '',
      ].join('|'),
    );
  });

  it('is null for nobody, and unchanged by a profile edit', () => {
    expect(sessionIdentity(null)).toBeNull();
    expect(
      sessionIdentity({
        ...signedInUser,
        user: { ...signedInUser.user, name: 'Grace', locale: 'de' },
      }),
    ).toBe(sessionIdentity(signedInUser));
  });
});

describe('a refetch of `me` that changes the session', () => {
  it('forgets the previous tenant (issue #555)', async () => {
    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    expect(queryClient.getQueryData(recordKey)).toMatchObject({
      title: 'Old tenant note',
    });

    // The cookie was re-issued for another tenant (POST /v1/auth/tenant,
    // here or another tab): the next refetch of `me` answers as it.
    meAfter(meInTenant(otherTenantId));
    await fetchMe(queryClient);

    // The refetch's own success starts the reset (a watcher step): settled,
    // the cache holds the new context's `me` and nothing of the old one.
    await waitFor(() => {
      expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
        tenant: { id: otherTenantId },
      });
      expect(queryClient.getQueryData(recordKey)).toBeUndefined();
      expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });
    expect(to.toSignIn).not.toHaveBeenCalled();
  });

  it('forgets it again when the refetch answers as another account', async () => {
    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    meAfter(otherUserMe);
    await fetchMe(queryClient);
    await waitFor(() => {
      expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
        user: { id: otherUserId },
      });
      expect(queryClient.getQueryData(recordKey)).toBeUndefined();
      expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
    });
  });

  it('forgets it again when the refetch answers as an impersonation', async () => {
    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    meAfter(impersonatingMe);
    await fetchMe(queryClient);
    await waitFor(() => {
      expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
        user: { impersonator: { id: signedInUser.user.id } },
      });
      expect(queryClient.getQueryData(recordKey)).toBeUndefined();
      expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
    });
  });

  it('keeps a stale tenant A answer out, and refetches what is mounted', async () => {
    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    // A mounted query whose tenant-A answer is still in flight while `me`
    // refetches as tenant B: the reset cancels the old fetch, so its answer
    // never lands, and the mounted query refetches as the new session.
    let switched = false;
    let resolveA: (data: { items: string[] }) => void = () => undefined;
    const pending = new Promise<{ items: string[] }>((resolve) => {
      resolveA = resolve;
    });
    const stop = new QueryObserver(queryClient, {
      queryKey: ['in-flight'],
      queryFn: async () =>
        switched ? { items: ['tenant B in-flight'] } : await pending,
    });
    const unsubscribe = stop.subscribe(() => undefined);
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(['in-flight'])?.fetchStatus).toBe(
        'fetching',
      ),
    );

    switched = true;
    meAfter(meInTenant(otherTenantId));
    await fetchMe(queryClient);
    resolveA({ items: ['tenant A in-flight'] });
    await waitFor(() =>
      expect(queryClient.getQueryData(['in-flight'])).toEqual({
        items: ['tenant B in-flight'],
      }),
    );
    unsubscribe();
  });

  it('does not treat clearing the mutation cache as aborting a sent mutation', async () => {
    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    let started!: () => void;
    let finish!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<string>((resolve) => {
      finish = () => resolve('request completed');
    });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        started();
        return response;
      },
    });
    const inFlight = mutation.execute(undefined);
    await requestStarted;

    // The server has already received the request. A session change clears
    // its client cache entry but cannot promise to abort the server work.
    meAfter(otherUserMe);
    await fetchMe(queryClient);
    await waitFor(() =>
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0),
    );
    finish();

    await expect(inFlight).resolves.toBe('request completed');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(recordKey)).toBeUndefined();
  });
});

describe('a refetch of `me` that does not change the session', () => {
  it('keeps the cache and the mounted page as they are', async () => {
    useSignedIn([]);
    const { queryClient } = await renderApp('/notifications');
    await screen.findByText('Acme');
    queryClient.setQueryData(recordKey, {
      id: 'tag-a',
      title: 'Old tenant note',
    });
    queryClient.setQueryData(['orphan'], 'old tenant');
    let listCalls = 0;
    server.use(
      http.get('/v1/notifications', () => {
        listCalls += 1;
        return HttpResponse.json({
          items: [
            { id: 'n2', type: 'comment.mentioned', title: 'Must not appear' },
          ],
          nextCursor: null,
        });
      }),
    );

    // A refetch of `me` (a window focus, a route guard) answering as the
    // same session — even a profile edit (a new object, the same identity):
    // nothing cached belongs to another context, so nothing is reset, the
    // page is not refetched and keeps its data.
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json({
          ...signedInUser,
          user: { ...signedInUser.user, name: 'Ada Lovelace II', locale: 'de' },
        }),
      ),
    );
    await fetchMe(queryClient);

    expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
      user: { name: 'Ada Lovelace II' },
    });
    expect(listCalls).toBe(0);
    expect(screen.queryByText('Must not appear')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(recordKey)).toMatchObject({
      title: 'Old tenant note',
    });
    expect(queryClient.getQueryData(['orphan'])).toEqual('old tenant');
  });
});

describe('the session another tab announced', () => {
  it('applies a switch announced by another tab', async () => {
    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );

    // Another tab switched (its flow reset and announced): this tab forgets
    // the previous context now, not at its next refetch, and its own read
    // under the re-issued cookie confirms who the session is.
    meAfter(meInTenant(otherTenantId));
    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));
    await waitFor(() =>
      expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
        tenant: { id: otherTenantId },
      }),
    );
    expect(queryClient.getQueryData(recordKey)).toBeUndefined();
    expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
    // And the page's route guards run again, for the new session.
    await waitFor(() => expect(to.invalidate).toHaveBeenCalledOnce());
  });

  it('keeps the cache when the announcement changes nothing here', async () => {
    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    announceSessionIdentity(sessionIdentity(signedInUser));
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(['orphan'])).toEqual('old tenant'),
    );
    expect(queryClient.getQueryData(recordKey)).toMatchObject({
      title: 'Old tenant note',
    });
  });

  it('ignores an announcement made before this tab read `me` once', async () => {
    server.use(
      http.get('/v1/auth/me', () =>
        HttpResponse.json(meInTenant(otherTenantId)),
      ),
    );
    const to = target();
    const queryClient = createQueryClient(() => to);
    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeUndefined();
    expect(to.toSignIn).not.toHaveBeenCalled();
  });

  it('ends the session here when another tab signs out', async () => {
    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );

    // Another tab signed out (its `clear` announced): the cookie is read
    // back, and the 401 the SERVER answers — not the message — ends this
    // tab's session too, exactly as its own 401 would have.
    server.use(http.get('/v1/auth/me', () => problem(401, 'unauthorized')));
    announceSessionIdentity(null);

    await waitFor(() => expect(to.toSignIn).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
    expect(queryClient.getQueryData(recordKey)).toBeUndefined();
    expect(queryClient.getQueryData(['orphan'])).toBeUndefined();
  });

  it('changes nothing for a sign-out announcement another tab undid', async () => {
    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );

    // Signed out there, then signed back in before this tab read the
    // announcement: the message is stale, the cookie is alive — the read
    // back says so, and the tab stays signed in with its data.
    announceSessionIdentity(null);

    await vi.waitFor(() =>
      expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
        tenant: { id: signedInUser.tenant!.id },
      }),
    );
    expect(to.toSignIn).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(recordKey)).toMatchObject({
      title: 'Old tenant note',
    });
    expect(queryClient.getQueryData(['orphan'])).toEqual('old tenant');
  });

  it('reads a forged identity announcement back and changes nothing', async () => {
    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    // What a script of this origin could post: another identity than the
    // cookie's. It is read back once; the server's answer (this session's
    // own) decides, so nothing is reset, dropped or navigated.
    let meReads = 0;
    server.use(
      http.get('/v1/auth/me', () => {
        meReads += 1;
        return HttpResponse.json(meInTenant(signedInUser.tenant!.id));
      }),
    );

    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));

    await vi.waitFor(() => expect(meReads).toBe(1));
    expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
      tenant: { id: signedInUser.tenant!.id },
    });
    expect(queryClient.getQueryData(recordKey)).toMatchObject({
      title: 'Old tenant note',
    });
    expect(queryClient.getQueryData(['orphan'])).toEqual('old tenant');
    expect(to.toSignIn).not.toHaveBeenCalled();
  });

  it('changes nothing for an announcement that cannot be read back', async () => {
    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );

    // The network is down when the announcement arrives: ending or
    // resetting a session on a message's word is exactly what must not
    // happen — the next refetch, or a 401, says what the session is.
    server.use(http.get('/v1/auth/me', () => HttpResponse.error()));
    announceSessionIdentity(null);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
      tenant: { id: signedInUser.tenant!.id },
    });
    expect(to.toSignIn).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(recordKey)).toMatchObject({
      title: 'Old tenant note',
    });
  });
});

describe('the session a flow here applies, announced to the other tabs', () => {
  it('resets another tab when a tenant switch is announced', async () => {
    const tenantA = meInTenant(signedInUser.tenant!.id);
    const firstTab = await watchedClient(tenantA);
    const secondTab = await watchedClient(tenantA);

    meAfter(meInTenant(otherTenantId));
    await createSession(firstTab.queryClient).reset();

    // Separate watched clients stand in for two open tabs sharing the
    // BroadcastChannel and cookie. The receiver verifies the hint through
    // /auth/me before resetting its own tenant-A cache.
    await waitFor(() => {
      expect(
        secondTab.queryClient.getQueryData(meQuery.queryKey),
      ).toMatchObject({ tenant: { id: otherTenantId } });
      expect(secondTab.queryClient.getQueryData(recordKey)).toBeUndefined();
      expect(secondTab.queryClient.getQueryData(['orphan'])).toBeUndefined();
      expect(secondTab.queryClient.getMutationCache().getAll()).toHaveLength(0);
    });
  });

  it('announces the reset after a switch, and applies it once', async () => {
    const received: (string | null)[] = [];
    const inbox = new BroadcastChannel('app-session-identity');
    inbox.onmessage = ({ data }) => received.push(data ?? null);

    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    meAfter(meInTenant(otherTenantId));
    await createSession(queryClient).reset();

    // The first sighting (the client's initial read) announced the old
    // identity; the reset announced the new one under the re-issued cookie.
    expect(received).toEqual([
      sessionIdentity(signedInUser),
      sessionIdentity(meInTenant(otherTenantId)),
    ]);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(recordKey)).toBeUndefined();
  });

  it('announces a sign out', async () => {
    const received: (string | null)[] = [];
    const inbox = new BroadcastChannel('app-session-identity');
    inbox.onmessage = ({ data }) => received.push(data ?? null);

    const { to, queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );

    createSession(queryClient).clear();

    // The first sighting's announcement, then the sign out's null.
    expect(received).toEqual([sessionIdentity(signedInUser), null]);
    expect(to.toSignIn).not.toHaveBeenCalled();
  });
});

describe('the watcher on the rendered app', () => {
  it('shows the new session where the old one was, without a reset flow here', async () => {
    notifications('Q3 targets');
    useSignedIn([]);
    const { queryClient } = await renderApp('/notifications');
    await screen.findByText('Q3 targets');

    // POST /v1/auth/tenant in another tab re-issued the shared cookie: its
    // reset announces this session's new tenant, and this tab follows at
    // once — the old tenant's data is dropped, the page refetches as the
    // new session's. Two reads of `me` under the new cookie follow: one that
    // confirms the announcement against the server, and the reset's own.
    let meCalls = 0;
    server.use(
      http.get('/v1/auth/me', () => {
        meCalls += 1;
        return HttpResponse.json(meInTenant(otherTenantId));
      }),
    );
    notifications('Q4 plans');
    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));

    await screen.findByText('Q4 plans', { exact: false });
    expect(await screen.findByText('Globex')).toBeVisible();
    expect(screen.queryByText('Q3 targets')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(meQuery.queryKey)).toMatchObject({
      tenant: { id: otherTenantId },
    });
    await waitFor(() => expect(meCalls).toBe(2));
  });

  it("runs the page's route guards again for the new session", async () => {
    useSignedIn(['Access.readAudit']);
    const { router } = await renderApp('/audit');
    expect(router.state.location.pathname).toBe('/audit');

    // Another tab switched to a tenant where this account may not read the
    // audit log: the page this tab shows is left, not kept on screen with
    // its refetches refused.
    meAfter(meInTenant(otherTenantId));
    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('does not reset again for its own announcement, mid-apply', async () => {
    const { queryClient } = await watchedClient(
      meInTenant(signedInUser.tenant!.id),
    );
    let meCalls = 0;
    server.use(
      http.get('/v1/auth/me', () => {
        meCalls += 1;
        return HttpResponse.json(meInTenant(otherTenantId));
      }),
    );

    // The flow the tab itself ran (a switch) resets, announces and refetches;
    // its own announcement backtracking through the channel, and the `me`
    // answer it refetched, must not apply a second reset.
    const resetting = createSession(queryClient).reset();
    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));
    await resetting;

    expect(meCalls).toBe(1);
    expect(queryClient.getQueryData(recordKey)).toBeUndefined();
  });
});

describe('a step-up dialog open when the session changes', () => {
  it('closes, and its request is never sent again under the new session', async () => {
    notifications('Q3 targets');
    useSignedIn([]);
    let creates = 0;
    server.use(
      http.post('/v1/access/clients', () => {
        creates += 1;
        return problem(403, 'reauthentication_required', {
          methods: ['password'],
        });
      }),
    );
    await renderApp('/notifications');
    await screen.findByText('Q3 targets');

    // An API key for this tenant is refused for an old sign-in: the dialog
    // asks the user to confirm it's them before the request goes again.
    // Its outcome is held from the start: it settles while the switch runs.
    const sent = api
      .POST('/v1/access/clients', {
        body: { name: 'CI deploys' } as CreateClientBody,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await screen.findByRole('dialog', { name: /confirm/i });

    // Another tab switched to tenant B meanwhile: the request was built for
    // tenant A, and confirming now would resend it under B's cookie.
    meAfter(meInTenant(otherTenantId));
    notifications('Q4 plans');
    announceSessionIdentity(sessionIdentity(meInTenant(otherTenantId)));

    await screen.findByText('Q4 plans', { exact: false });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /confirm/i })).toBeNull(),
    );
    expect(await sent).toMatchObject({ code: 'reauthentication_required' });
    expect(creates).toBe(1);
  });

  it('is settled by a sign-out too', async () => {
    const { queryClient } = await watchedClient(signedInUser);
    const asked = requestReauthentication({
      status: 403,
      code: 'reauthentication_required',
      detail: 'Confirm it is you.',
    });
    createSession(queryClient).clear();
    await expect(asked).resolves.toBe(false);
  });
});

describe('the bus listener of a thrown-away client', () => {
  it('hears nothing after it is disposed, and only the live one reads', async () => {
    // Repeated client creation must not accumulate live listeners: the bus
    // registry is module state (session-bus.ts). Five clients come and go —
    // each ends its listener when it is thrown away (teardownApps does this
    // after every test; here it is done at once) — then one live client.
    const thrownAway = await Promise.all(
      Array.from({ length: 5 }, () =>
        watchedClient(meInTenant(signedInUser.tenant!.id)),
      ),
    );
    for (const { queryClient } of thrownAway) {
      sessionWatch(queryClient).offBus?.();
    }
    const live = await watchedClient(meInTenant(signedInUser.tenant!.id));

    // The sign-out is real now: the server says so.
    let meReads = 0;
    server.use(
      http.get('/v1/auth/me', () => {
        meReads += 1;
        return problem(401, 'unauthorized');
      }),
    );
    announceSessionIdentity(null);

    await waitFor(() => expect(live.to.toSignIn).toHaveBeenCalledTimes(1));
    // Only the live client's listener read the cookie back: had any of the
    // thrown-away ones still been listening, it would have read too.
    expect(meReads).toBe(1);
    for (const { to } of thrownAway) {
      expect(to.toSignIn).not.toHaveBeenCalled();
    }
  });
});
