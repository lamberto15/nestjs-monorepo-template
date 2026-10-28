import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

// The account's pages under one row of tabs (links: each is its own page and
// URL), so the user menu needs one entry for all of them.
export const Route = createFileRoute('/_app/account')({
  component: AccountLayout,
});

/** Each page's tab: its route, and the i18n key of its title. */
const tabs = [
  { to: '/account/profile', label: 'account.profile.title' },
  { to: '/account/preferences', label: 'settings:preferences.title' },
  { to: '/account/security', label: 'account.security.title' },
  { to: '/account/notifications', label: 'notifications:preferences.title' },
  { to: '/account/watching', label: 'watching:title' },
  { to: '/account/privacy', label: 'privacy:title' },
] as const;

function AccountLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      {/* Wider than a phone: it scrolls sideways, not the page. */}
      <nav aria-label={t('account.tabs')} className="overflow-x-auto border-b">
        <ul className="flex gap-1">
          {tabs.map((tab) => (
            <li key={tab.to}>
              <Link
                to={tab.to}
                className="inline-flex h-10 items-center border-b-2 border-transparent px-3 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground data-[status=active]:border-primary data-[status=active]:font-medium data-[status=active]:text-foreground"
              >
                {t(tab.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
