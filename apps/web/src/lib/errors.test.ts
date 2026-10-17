import { ApiError } from '@nestjs-monorepo-template/api-client';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { reauthenticationMiddleware } from '@/lib/api';
import { createQueryClient, handleApiError } from '@/lib/errors';
import { meQuery } from '@/lib/session';
import { problem, server, signedInUser } from '@/test/server';
import { createApiClient, unwrap } from '@nestjs-monorepo-template/api-client';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('the global error handler', () => {
  it('sends a user whose session ended to sign-in, back here afterwards', () => {
    const toSignIn = vi.fn();
    const target = { currentHref: () => '/notes?page=2', toSignIn };
    const queryClient = createQueryClient(() => target);
    queryClient.setQueryData(meQuery.queryKey, signedInUser);
    queryClient.setQueryData(['notes'], { items: [] });

    handleApiError(
      queryClient,
      target,
      new ApiError({ status: 401, code: 'unauthorized' }),
      undefined,
    );

    expect(toSignIn).toHaveBeenCalledWith('/notes?page=2');
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
    expect(queryClient.getQueryData(['notes'])).toBeUndefined();
  });

  it('leaves a 401 to the form when nobody was signed in (a wrong password)', () => {
    const toSignIn = vi.fn();
    const target = { currentHref: () => '/sign-in', toSignIn };
    const queryClient = createQueryClient(() => target);
    queryClient.setQueryData(meQuery.queryKey, null);
    handleApiError(
      queryClient,
      target,
      new ApiError({ status: 401, code: 'unauthorized' }),
      { errorToast: false },
    );
    expect(toSignIn).not.toHaveBeenCalled();
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
