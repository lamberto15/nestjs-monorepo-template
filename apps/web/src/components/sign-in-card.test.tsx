import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/common.json';
import { SignInCard } from './sign-in-card';

describe('SignInCard', () => {
  it('renders the translated title', async () => {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { common: en } },
      defaultNS: 'common',
    });
    render(
      <I18nextProvider i18n={i18n}>
        <SignInCard />
      </I18nextProvider>,
    );
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });
});
