import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/common.json';
import { App, createAppRouter } from './app';

// The app as main.tsx mounts it (the same App, every provider): a provider
// in the wrong place (nuqs's adapter around RouterProvider once) blanks every
// page, which component tests alone don't see.
async function renderApp(path: string) {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: en } },
    defaultNS: 'common',
  });
  const queryClient = new QueryClient();
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} i18n={i18n} />);
}

describe('the app', () => {
  it('renders the sign-in page', async () => {
    await renderApp('/sign-in');
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
  });
});
