import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { nav } from '@/nav';

/**
 * What a client-side navigation leaves to the app (TanStack Router renders
 * the page, nothing more): the page's title, where the focus goes, and a way
 * past the menu. Custom code, because the router has no route announcer.
 */

/** The page's content: the skip link's target and the focus after a navigation. */
export const MAIN_CONTENT_ID = 'main-content';

// The pages the menu does not list (the user menu's, the signed-out ones).
const pageTitles: Record<string, string> = {
  '/sign-in': 'auth.signIn.title',
  '/sign-up': 'auth.signUp.title',
  '/forgot-password': 'auth.forgot.title',
  '/reset-password': 'auth.reset.title',
  '/magic-link': 'auth.magicLink.title',
  '/verify-email': 'auth.verify.title',
  '/accept-invitation': 'auth.invitation.title',
  '/cancel-deletion': 'auth.cancelDeletion.title',
  '/unsubscribe': 'auth.unsubscribe.title',
  '/onboarding': 'onboarding.title',
  '/account/profile': 'account.profile.title',
  '/account/preferences': 'settings:preferences.title',
  '/account/security': 'account.security.title',
  '/account/notifications': 'notifications:preferences.title',
  '/account/watching': 'watching:title',
  '/account/privacy': 'privacy:title',
};

const menuTitles = Object.fromEntries(
  nav.flatMap((group) => group.items.map((item) => [item.to, item.label])),
);

/**
 * The title's i18n key for a path: its page's, else the menu entry of the
 * section it is in (a note's page is under "Notes").
 */
export function pageTitleKey(pathname: string): string | undefined {
  const titles = { ...menuTitles, ...pageTitles };
  if (pathname === '/') {
    return titles['/'];
  }
  const section = Object.keys(titles)
    .filter((to) => to !== '/')
    .filter((to) => pathname === to || pathname.startsWith(`${to}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  return section && titles[section];
}

/**
 * The document's title (WCAG 2.4.2): the page, then the app. React hoists
 * the `<title>` into the head; it follows the language as the page does.
 */
export function PageTitle() {
  const { t } = useTranslation();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const key = pageTitleKey(pathname);
  const app = t('app.name');
  return <title>{key ? `${t(key)} · ${app}` : app}</title>;
}

/**
 * After a navigation to another page (not a filter or a sort, which change
 * the search only), the focus goes to the new page's heading, else its
 * content, so a keyboard or screen-reader user starts there rather than on
 * the link they left. Not on the first load, and not when the page has put
 * the focus somewhere itself (its first field, an open dialog).
 */
export function RouteFocus() {
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe('onRendered', ({ fromLocation, pathChanged }) => {
        if (!fromLocation || !pathChanged) {
          return;
        }
        const content =
          document.getElementById(MAIN_CONTENT_ID) ??
          document.querySelector('main');
        if (!content) {
          return;
        }
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          (content.contains(active) ||
            active.closest('[role="dialog"], [role="alertdialog"]'))
        ) {
          return;
        }
        const target =
          content.querySelector<HTMLElement>(
            'h1, [role="heading"][aria-level="1"]',
          ) ?? content;
        if (!target.hasAttribute('tabindex')) {
          target.setAttribute('tabindex', '-1');
        }
        target.focus({ preventScroll: true });
      }),
    [router],
  );
  return null;
}

/**
 * The first thing a keyboard user reaches: past the menu to the page. A
 * button's behaviour on a link: following `#main-content` would put the
 * fragment in the router's location (and in the `redirect` of a later
 * sign-in), so the click moves the focus instead.
 */
export function SkipToContent() {
  const { t } = useTranslation();
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(MAIN_CONTENT_ID)?.focus();
      }}
    >
      {t('nav.skipToContent')}
    </a>
  );
}
