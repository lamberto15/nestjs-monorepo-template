import { ApiError } from '@nestjs-monorepo-template/api-client';
import { QueryObserver, type QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw/http';
import { toast } from 'sonner';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '@/i18n';
import { api, reauthenticationMiddleware } from '@/lib/api';
import { createQueryClient, handleApiError } from '@/lib/errors';
import { createSession, featuresQuery, meQuery } from '@/lib/session';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { createApiClient, unwrap } from '@nestjs-monorepo-template/api-client';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const target = (inApp = true) => ({
  currentHref: () => '/notes?page=2',
  inApp: () => inApp,
  toSignIn: vi.fn(),
  toMfaSetup: vi.fn(),
  toOnboarding: vi.fn(),
});

describe('the global error handler', () => {
  // Its toasts are worded with the app's own i18n.
  beforeAll(async () => {
    await initI18n();
  });
  beforeEach(() => vi.mocked(toast.error).mockClear());

  it('sends a user whose session ended to sign-in, back here afterwards', () => {
    const to = target();
    const queryClient = createQueryClient(() => to);
    queryClient.setQueryData(meQuery.queryKey, signedInUser);
    queryClient.setQueryData(['notes'], { items: [] });

    handleApiError(
      queryClient,
      to,
      new ApiError({ status: 401, code: 'unauthorized' }),
      undefined,
    );

    expect(to.toSignIn).toHaveBeenCalledWith('/notes?page=2');
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
    expect(queryClient.getQueryData(['notes'])).toBeUndefined();
  });

  it('turns three 401s at once into one trip to sign-in and no toast', async () => {
    server.use(
      http.get('/v1/auth/sessions', () => problem(401, 'unauthorized')),
      http.get('/v1/auth/passkeys', () => problem(401, 'unauthorized')),
      http.get('/v1/auth/mfa', () => problem(401, 'unauthorized')),
    );
    const to = target();
    const queryClient = createQueryClient(() => to);
    queryClient.setQueryData(meQuery.queryKey, signedInUser);
    await Promise.allSettled([
      queryClient.fetchQuery({
        queryKey: ['sessions'],
        queryFn: () => unwrap(api.GET('/v1/auth/sessions')),
      }),
      queryClient.fetchQuery({
        queryKey: ['passkeys'],
        queryFn: () => unwrap(api.GET('/v1/auth/passkeys')),
      }),
      queryClient.fetchQuery({
        queryKey: ['mfa'],
        queryFn: () => unwrap(api.GET('/v1/auth/mfa')),
      }),
    ]);
    expect(to.toSignIn).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('never toasts a 401, even when nobody was signed in', () => {
    const to = target(false);
    const queryClient = createQueryClient(() => to);
    queryClient.setQueryData(meQuery.queryKey, null);
    handleApiError(
      queryClient,
      to,
      new ApiError({ status: 401, code: 'unauthorized' }),
      undefined,
    );
    expect(to.toSignIn).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('sends a user who must set up two-factor to the setup page, once explained', () => {
    const to = target();
    const queryClient = createQueryClient(() => to);
    handleApiError(
      queryClient,
      to,
      new ApiError({ status: 403, code: 'mfa_enrollment_required' }),
      undefined,
    );
    expect(to.toMfaSetup).toHaveBeenCalledOnce();
    expect(toast.info).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('sends the first administrator mid-onboarding to the onboarding page', () => {
    const to = target();
    const queryClient = createQueryClient(() => to);
    handleApiError(
      queryClient,
      to,
      new ApiError({ status: 403, code: 'onboarding_required' }),
      undefined,
    );
    expect(to.toOnboarding).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts any other problem with its detail', () => {
    const queryClient = createQueryClient(() => target());
    handleApiError(
      queryClient,
      target(),
      new ApiError({ status: 409, code: 'conflict', detail: 'Already there' }),
      undefined,
    );
    expect(toast.error).toHaveBeenCalledWith('Already there');
  });

  describe.each(['read_only', 'maintenance'])(
    'a request refused by the deployment mode (503 %s)',
    (code) => {
      const refused = () =>
        new ApiError({ status: 503, code, detail: `refused: ${code}` });

      /** The switches watched by something on screen: an active observer. */
      const watching = (queryClient: QueryClient) =>
        new QueryObserver(queryClient, featuresQuery).subscribe(
          () => undefined,
        );

      it('asks for the mode again at once, and toasts once', async () => {
        let asked = 0;
        server.use(
          http.get('/v1/features', () => {
            asked += 1;
            return HttpResponse.json(allFeatures);
          }),
        );
        const queryClient = createQueryClient(() => target());
        const stop = watching(queryClient);
        await vi.waitFor(() => expect(asked).toBe(1));

        handleApiError(queryClient, target(), refused(), undefined);
        await vi.waitFor(() => expect(asked).toBe(2));
        expect(toast.error).toHaveBeenCalledWith(`refused: ${code}`, {
          id: 'deployment-mode',
        });
        stop();
      });

      it('asks once for a page of refused requests, not once each', async () => {
        let asked = 0;
        server.use(
          http.get('/v1/features', async () => {
            asked += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return HttpResponse.json(allFeatures);
          }),
        );
        const queryClient = createQueryClient(() => target());
        const stop = watching(queryClient);
        await vi.waitFor(() => expect(asked).toBe(1));
        const idle = () =>
          expect(
            queryClient.isFetching({ queryKey: featuresQuery.queryKey }),
          ).toBe(0);
        await vi.waitFor(idle);

        for (let i = 0; i < 5; i += 1) {
          handleApiError(queryClient, target(), refused(), undefined);
        }
        await vi.waitFor(idle);
        expect(asked).toBe(2);
        stop();
      });

      it('leaves the toast to a caller that shows the error itself', () => {
        const queryClient = createQueryClient(() => target());
        handleApiError(queryClient, target(), refused(), {
          errorToast: false,
        });
        expect(toast.error).not.toHaveBeenCalled();
      });
    },
  );

  it('toasts a 503 that is not the mode like any other problem', () => {
    const queryClient = createQueryClient(() => target());
    handleApiError(
      queryClient,
      target(),
      new ApiError({ status: 503, code: 'unavailable', detail: 'Down' }),
      undefined,
    );
    expect(toast.error).toHaveBeenCalledWith('Down');
  });

  it('gives the request id of a 5xx, which the API logged the error under', () => {
    const queryClient = createQueryClient(() => target());
    handleApiError(
      queryClient,
      target(),
      new ApiError({
        status: 500,
        code: 'internal',
        detail: 'Something broke.',
        requestId: 'req-12345678',
      }),
      undefined,
    );
    expect(toast.error).toHaveBeenCalledWith('Something broke.', {
      description: 'Request ID: req-12345678',
    });
  });

  it('reports an error that is not the API answer, and says so with its report id', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queryClient = createQueryClient(() => target());
    // A bug in a query function, not a connection that dropped.
    const bug = new TypeError(
      "Cannot read properties of undefined (reading 'id')",
    );
    handleApiError(queryClient, target(), bug, undefined);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/^\[[0-9a-f]{8}\] request error$/),
      bug,
    );
    expect(toast.error).toHaveBeenCalledWith('Something went wrong.', {
      description: expect.stringMatching(/^Report ID: [0-9a-f]{8}$/),
    });
    logged.mockRestore();
  });

  it('says a dropped connection is one, and reports nothing', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queryClient = createQueryClient(() => target());
    handleApiError(
      queryClient,
      target(),
      new TypeError('Failed to fetch'),
      undefined,
    );
    expect(logged).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "The server can't be reached. Check your connection and try again.",
    );
    logged.mockRestore();
  });

  it('goes to sign-in when a refetch of `me` finds nobody signed in', async () => {
    const to = target();
    const queryClient = createQueryClient(() => to);
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(signedInUser)));
    await queryClient.fetchQuery(meQuery);
    // Signed out in another tab: the next refetch answers 401 (me: null).
    server.use(http.get('/v1/auth/me', () => problem(401, 'unauthorized')));
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    expect(to.toSignIn).toHaveBeenCalledExactlyOnceWith('/notes?page=2');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays put when the app itself set `me` to null (signing out)', () => {
    const to = target();
    const queryClient = createQueryClient(() => to);
    queryClient.setQueryData(meQuery.queryKey, signedInUser);
    createSession(queryClient).clear();
    expect(to.toSignIn).not.toHaveBeenCalled();
  });

  it('forgets mutations (their variables and results) with the session', async () => {
    const queryClient = createQueryClient(() => target());
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: async () => ['recovery-code'] })
      .execute(undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
    createSession(queryClient).clear();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});

describe('step-up (reauthentication_required)', () => {
  const client = (ask: () => Promise<boolean>) => {
    const api = createApiClient({
      baseUrl: location.origin,
      credentials: 'include',
      fetch: (input, init) => globalThis.fetch(input, init),
    });
    api.use(reauthenticationMiddleware(ask));
    return api;
  };

  it('asks the user, then sends the same request again with a new key', async () => {
    const keys: (string | null)[] = [];
    const bodies: unknown[] = [];
    let calls = 0;
    server.use(
      http.post('/v1/auth/password/change', async ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        bodies.push(await request.json());
        calls += 1;
        return calls === 1
          ? problem(403, 'reauthentication_required', { methods: ['password'] })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const ask = vi.fn(async () => true);
    const { response } = await client(ask).POST('/v1/auth/password/change', {
      body: { newPassword: 'a long new password' },
    });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'reauthentication_required',
        methods: ['password'],
      }),
    );
    expect(response.status).toBe(204);
    expect(bodies).toEqual([
      { newPassword: 'a long new password' },
      { newPassword: 'a long new password' },
    ]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps an Idempotency-Key the caller set', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post('/v1/auth/mfa/enroll', ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return keys.length === 1
          ? problem(403, 'reauthentication_required')
          : HttpResponse.json({ secret: 'S', uri: 'otpauth://totp/x' });
      }),
    );
    await unwrap(
      client(async () => true).POST('/v1/auth/mfa/enroll', {
        params: { header: { 'Idempotency-Key': 'mine' } } as never,
      }),
    );
    expect(keys).toEqual(['mine', 'mine']);
  });

  it('throws the 403 when the user gives up', async () => {
    server.use(
      http.post('/v1/auth/mfa/enroll', () =>
        problem(403, 'reauthentication_required'),
      ),
    );
    const ask = vi.fn(async () => false);
    await expect(
      unwrap(client(ask).POST('/v1/auth/mfa/enroll')),
    ).rejects.toMatchObject({
      status: 403,
      code: 'reauthentication_required',
    });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('leaves other 403s alone', async () => {
    server.use(http.get('/v1/auth/mfa', () => problem(403, 'forbidden')));
    const ask = vi.fn(async () => true);
    await expect(unwrap(client(ask).GET('/v1/auth/mfa'))).rejects.toMatchObject(
      {
        code: 'forbidden',
      },
    );
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('the query retry rule', () => {
  const retry = createQueryClient(() => undefined).getDefaultOptions().queries!
    .retry as (count: number, error: Error) => boolean;
  const failed = (status: number, code?: string) =>
    new ApiError({ status, ...(code && { code }) });

  it('asks a failing server again, twice', () => {
    expect(retry(0, failed(500))).toBe(true);
    expect(retry(1, failed(502))).toBe(true);
    expect(retry(2, failed(500))).toBe(false);
  });

  it('does not ask again after a 4xx', () => {
    expect(retry(0, failed(404, 'not_found'))).toBe(false);
  });

  it("does not ask again what the deployment's mode refused (503 read_only, maintenance)", () => {
    // The refusal says to wait 30 s and the mode watch asks when it has
    // ended: a retry after 1 s and 2 s only held the page that saw it.
    expect(retry(0, failed(503, 'maintenance'))).toBe(false);
    expect(retry(0, failed(503, 'read_only'))).toBe(false);
    // Any other 503 (a proxy, a restart) is still worth asking again.
    expect(retry(0, failed(503))).toBe(true);
  });
});
