import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import en from '@/locales/en/common.json';
import { ReauthDialog } from '@/components/reauth-dialog';
import { requestReauthentication, settleReauthentication } from '@/lib/reauth';

async function renderDialog() {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: en } },
    defaultNS: 'common',
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <ReauthDialog />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('the re-authenticate dialog', () => {
  afterEach(() => {
    act(() => settleReauthentication(false));
    window.history.replaceState(null, '', '/');
  });

  it("sends a provider's step-up back to this page", async () => {
    window.history.replaceState(null, '', '/notes?page=2');
    await renderDialog();
    act(() => {
      void requestReauthentication({
        status: 403,
        code: 'reauthentication_required',
        methods: ['oidc:google'],
      });
    });
    expect(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    ).toHaveAttribute(
      'href',
      '/v1/auth/oidc/google/login?reauthenticate=true&redirectTo=%2Fnotes%3Fpage%3D2',
    );
  });

  it('never passes on a path that is not a safe one', async () => {
    // A path the browser keeps as is, but a redirect would read as a host.
    window.history.replaceState(null, '', '/..//evil.example/x');
    await renderDialog();
    act(() => {
      void requestReauthentication({
        status: 403,
        code: 'reauthentication_required',
        methods: ['oidc:google'],
      });
    });
    expect(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    ).toHaveAttribute(
      'href',
      '/v1/auth/oidc/google/login?reauthenticate=true&redirectTo=%2F',
    );
  });
});
