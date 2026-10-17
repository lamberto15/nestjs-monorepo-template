import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resourcesFrom } from '@/i18n';
import { App, createApp } from '@/app';

// Every English namespace (common, nav, a feature's), as main.tsx loads them.
const en = resourcesFrom(
  import.meta.glob<Record<string, unknown>>('@/locales/en/*.json', {
    eager: true,
    import: 'default',
  }),
)['en']!;

/** The whole app (every provider, the router, the error handler) at a path. */
export async function renderApp(path: string) {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en },
    defaultNS: 'common',
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const { queryClient, router } = createApp(history);
  render(<App router={router} queryClient={queryClient} i18n={i18n} />);
  return { router, queryClient, history };
}
