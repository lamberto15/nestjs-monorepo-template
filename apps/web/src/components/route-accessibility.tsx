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

const menuTitles = Object.fromEntries(
  nav.flatMap((group) => group.items.map((item) => [item.to, item.label])),
);

/**
 * The title's i18n key for a path in the menu: the entry of the section it
 * is in (a note's page is under "Notes").
 */
export function pageTitleKey(pathname: string): string | undefined {
  if (pathname === '/') {
    return menuTitles['/'];
  }
  const section = Object.keys(menuTitles)
    .filter((to) => to !== '/')
    .filter((to) => pathname === to || pathname.startsWith(`${to}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  return section && menuTitles[section];
}

/**
 * The document's title (WCAG 2.4.2): the page, then the app. A page the
 * menu does not list names itself in its route's `staticData.title`
 * (TanStack Router's route metadata); the others take their menu entry.
 * React hoists the `<title>` into the head; it follows the language as the
 * page does.
 */
export function PageTitle() {
  const { t } = useTranslation();
  const key = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.title)?.staticData
        .title ?? pageTitleKey(state.location.pathname),
  });
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
