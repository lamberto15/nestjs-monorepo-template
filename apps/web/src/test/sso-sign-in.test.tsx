import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ssoLoginTarget } from '@/components/auth/sso-sign-in';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const LOGIN = `/v1/auth/sso/${TENANT}/${CONNECTION}/login`;

function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal('location', {
    href: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    assign,
  });
  return assign;
}

function discoverReturns(loginUrl: string | null) {
  const asked: unknown[] = [];
  server.use(
    http.post('/v1/auth/sso/discover', async ({ request }) => {
      asked.push(await request.json());
      return HttpResponse.json({ loginUrl });
    }),
  );
  return asked;
}

async function submit(path: string, email: string) {
  const user = userEvent.setup();
  await renderApp(path);
  await user.click(
    await screen.findByRole('button', { name: 'Sign in with SSO' }),
  );
  // The sign-in form has an email field too: the SSO form's is the last.
  await user.type(screen.getAllByLabelText('Email').at(-1)!, email);
  await user.click(screen.getAllByRole('button', { name: 'Continue' }).at(-1)!);
}

describe('Sign in with SSO', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a malformed address, with no request and no navigation', async () => {
    const assign = stubLocation();
    const asked = discoverReturns(LOGIN);
    await submit('/sign-in', 'acme');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /valid email address/,
    );
    expect(asked).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });

  it('goes to the discovered login route, back to where the user was headed', async () => {
    const assign = stubLocation();
    const asked = discoverReturns(LOGIN);
    await submit('/sign-in?redirect=%2Faccount%2Fprofile', 'ana@acme.com');
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        `${LOGIN}?redirectTo=%2Faccount%2Fprofile`,
      ),
    );
    expect(asked).toEqual([{ email: 'ana@acme.com' }]);
  });

  it('says neutrally that SSO is not available when no connection applies', async () => {
    const assign = stubLocation();
    discoverReturns(null);
    await submit('/sign-in', 'ana@nowhere.example');
    expect(await screen.findByRole('status')).toHaveTextContent(
      /isn’t available for that address/,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not follow a login URL that is not the API’s own', async () => {
    const assign = stubLocation();
    discoverReturns('https://evil.example/v1/auth/sso/x/y/login');
    await submit('/sign-in', 'ana@acme.com');
    expect(await screen.findByRole('status')).toHaveTextContent(
      /isn’t available for that address/,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('explains a failed SSO sign-in', async () => {
    await renderApp('/sign-in?error=sso_failed');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /SSO sign-in didn’t work/,
    );
  });
});

describe('ssoLoginTarget', () => {
  const origin = 'https://app.example.com';
  it('accepts the API’s login path, relative or on this origin', () => {
    expect(ssoLoginTarget(LOGIN, undefined, origin)).toBe(
      `${LOGIN}?redirectTo=%2F`,
    );
    expect(ssoLoginTarget(`${origin}${LOGIN}`, '/a', origin)).toBe(
      `${LOGIN}?redirectTo=%2Fa`,
    );
  });
  it.each([
    'https://evil.example/v1/auth/sso/a/b/login',
    '//evil.example/v1/auth/sso/a/b/login',
    '/\\evil.example/v1/auth/sso/a/b/login',
    'javascript:alert(1)',
    '/v1/auth/me',
    '/other',
    '',
  ])('refuses %j', (value) => {
    expect(ssoLoginTarget(value, undefined, origin)).toBeUndefined();
  });
});
