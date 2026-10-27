import { useDirection } from '@nestjs-monorepo-template/ui/components/direction';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { LanguageDirection } from '@/app';
import { pageTitleKey } from '@/components/route-accessibility';
import { peopleHandler } from '@/test/people';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

describe('the page title', () => {
  it('names the page, then the app, and follows the navigation', async () => {
    useSignedIn([]);
    server.use(peopleHandler([]));
    const { router } = await renderApp('/');
    await waitFor(() => expect(document.title).toBe('Dashboard · App'));

    await act(() => router.navigate({ to: '/account/profile' }));
    await waitFor(() => expect(document.title).toBe('Profile · App'));
  });

  it('names a signed-out page by its own title', async () => {
    await renderApp('/sign-in');
    await waitFor(() => expect(document.title).toBe('Sign in · App'));
  });

  it("names a record's page by its section in the menu", () => {
    expect(pageTitleKey('/access/roles/0199a3f2')).toBe(
      pageTitleKey('/access/roles'),
    );
    expect(pageTitleKey('/access/roles')).toBeDefined();
    // The dashboard is `/` alone, not the prefix of every page.
    expect(pageTitleKey('/nowhere')).toBeUndefined();
  });
});

describe('a navigation, for keyboard and screen-reader users', () => {
  it("moves the focus to the new page's heading", async () => {
    useSignedIn([]);
    server.use(peopleHandler([]));
    const { router } = await renderApp('/account/profile');
    await screen.findByRole('textbox', { name: 'Name' });
    // The first load leaves the focus where the browser (or a field) put it.
    expect(document.activeElement).toBe(document.body);

    await act(() => router.navigate({ to: '/' }));
    const heading = await screen.findByText('Dashboard', { selector: 'h1' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('leaves the focus alone when only the search changes (a filter, a sort)', async () => {
    useSignedIn([]);
    server.use(peopleHandler([]));
    const { router } = await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    // Somewhere the user is (the header's sidebar trigger).
    const toggle = screen.getAllByRole('button', {
      name: 'Toggle Sidebar',
    })[0]!;
    toggle.focus();

    await act(() => router.navigate({ to: '/', search: { tab: 1 } as never }));
    expect(toggle).toHaveFocus();
  });

  it('has a skip link first, past the menu to the page', async () => {
    useSignedIn([]);
    await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    const user = userEvent.setup();

    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    await user.click(skip);
    expect(document.getElementById('main-content')).toHaveFocus();
    // A focus move, not a fragment in the router's location.
    expect(window.location.hash).toBe('');
  });
});

describe('landmarks', () => {
  it('gives a signed-in page one <main>', async () => {
    useSignedIn([]);
    await renderApp('/');
    await screen.findByText('Dashboard', { selector: 'h1' });
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('gives a signed-out page a <main> and a level-one heading', async () => {
    await renderApp('/sign-in');
    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeVisible();
  });
});

describe("Base UI's direction", () => {
  function Shows() {
    return <p>{useDirection()}</p>;
  }

  it("is the language's: right to left in Arabic, and back after a switch", async () => {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({ lng: 'ar', resources: {} });
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageDirection>
          <Shows />
        </LanguageDirection>
      </I18nextProvider>,
    );
    expect(screen.getByText('rtl')).toBeInTheDocument();
    await act(() => i18n.changeLanguage('en'));
    expect(screen.getByText('ltr')).toBeInTheDocument();
  });
});
