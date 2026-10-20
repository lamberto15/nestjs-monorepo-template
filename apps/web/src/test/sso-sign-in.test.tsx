import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

describe('Sign in with SSO', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses ids that are not ids, with no navigation', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      assign,
    });
    const user = userEvent.setup();
    await renderApp('/sign-in');
    await user.click(
      await screen.findByRole('button', { name: 'Sign in with SSO' }),
    );
    await user.type(screen.getByLabelText('Workspace ID'), 'acme');
    await user.type(screen.getByLabelText('Connection ID'), CONNECTION);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/aren’t valid/);
    expect(assign).not.toHaveBeenCalled();
  });

  it('goes to the connection’s login route, back to where the user was headed', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      assign,
    });
    const user = userEvent.setup();
    await renderApp('/sign-in?redirect=%2Faccount%2Fprofile');
    await user.click(
      await screen.findByRole('button', { name: 'Sign in with SSO' }),
    );
    await user.type(screen.getByLabelText('Workspace ID'), TENANT);
    await user.type(screen.getByLabelText('Connection ID'), CONNECTION);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(assign).toHaveBeenCalledWith(
      `/v1/auth/sso/${TENANT}/${CONNECTION}/login?redirectTo=%2Faccount%2Fprofile`,
    );
  });

  it('explains a failed SSO sign-in', async () => {
    await renderApp('/sign-in?error=sso_failed');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /SSO sign-in didn’t work/,
    );
  });
});
