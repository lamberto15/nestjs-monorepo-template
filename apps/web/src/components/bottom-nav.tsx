import { Link } from '@tanstack/react-router';
import { useSidebar } from '@nestjs-monorepo-template/ui/components/sidebar';
import { MenuIcon, SearchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVisibleNav } from '@/components/nav-main';
import { openSearchPalette } from '@/features/search/palette';
import type { NavItem } from '@/nav';

/** The menu entries the bar repeats, in its order (when the user sees them). */
const tabs = ['/', '/notifications', '/approvals'];

const tab =
  'flex min-h-12 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-active:font-semibold data-active:text-primary [&_svg]:size-5';

/**
 * A phone's bar along the bottom (under 768px, the sidebar's own breakpoint):
 * the pages checked most, search, and Menu, which opens the sidebar's sheet
 * with every group. Desktop has the sidebar instead.
 */
export function BottomNav() {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();
  const home = useVisibleNav().find((group) => group.id === 'home');
  if (!isMobile) {
    return null;
  }
  const items = tabs
    .map((to) => home?.items.find((item) => item.to === to))
    .filter((item): item is NavItem => item !== undefined);
  return (
    <nav
      aria-label={t('nav.bottom')}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background px-1 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]"
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={tab}
          activeProps={{ 'data-active': true }}
          activeOptions={{ exact: item.to === '/' }}
        >
          <span className="relative">
            <item.icon aria-hidden />
            {item.badge && <TabBadge useCount={item.badge} />}
          </span>
          {item.to === '/' ? t('nav:groups.home') : t(item.label)}
        </Link>
      ))}
      <button type="button" className={tab} onClick={openSearchPalette}>
        <SearchIcon aria-hidden />
        {t('nav.search')}
      </button>
      <button
        type="button"
        className={tab}
        aria-haspopup="dialog"
        onClick={() => setOpenMobile(true)}
      >
        <MenuIcon aria-hidden />
        {t('nav.more')}
      </button>
    </nav>
  );
}

/** An entry's count on its icon (`NavItem.badge`); a component, since it calls a hook. */
function TabBadge(props: { useCount: NonNullable<NavItem['badge']> }) {
  const count = props.useCount();
  if (!count) {
    return null;
  }
  return (
    // Like the sidebar's badge, beside the name rather than part of it.
    <span
      aria-hidden
      className="absolute -end-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
