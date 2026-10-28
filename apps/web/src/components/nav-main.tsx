import { Link, useRouterState } from '@tanstack/react-router';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@nestjs-monorepo-template/ui/components/collapsible';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOperator } from '@/features/tenants/queries';
import { useFeatures, useMe } from '@/lib/features';
import {
  activeEntry,
  nav,
  visibleGroups,
  type NavGroup,
  type NavGroupId,
  type NavItem,
} from '@/nav';

/** The groups this user sees (UX only: the API enforces both). */
export function useVisibleNav(): NavGroup[] {
  const me = useMe();
  return visibleGroups(
    nav,
    useFeatures(),
    me?.can,
    useOperator(),
    me?.tenant?.operator === true,
  );
}

const storageKey = 'nav-groups';
type Opened = Partial<Record<NavGroupId, boolean>>;

/** Which groups the user opened or closed, on this browser (storage may be refused). */
function readOpened(): Opened {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return value && typeof value === 'object' ? (value as Opened) : {};
  } catch {
    return {};
  }
}

function saveOpened(opened: Opened) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(opened));
  } catch {
    // Not kept; the menu still opens and closes for this visit.
  }
}

export function NavMain() {
  const { t } = useTranslation();
  const { setOpenMobile, state, isMobile } = useSidebar();
  const groups = useVisibleNav();
  const pathname = useRouterState({
    select: (s) => s.location.pathname.replace(/(.)\/$/, '$1'),
  });
  const current = activeEntry(groups, pathname)?.group.id;
  const [opened, setOpened] = useState(readOpened);
  const toggle = (id: NavGroupId, open: boolean) => {
    const next = { ...opened, [id]: open };
    setOpened(next);
    saveOpened(next);
  };
  // Arriving on a page opens its group, so the menu shows where the user is
  // (set while rendering, React's way to follow a change of a derived value).
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    if (current && opened[current] === false) {
      setOpened({ ...opened, [current]: true });
    }
  }
  // The icon rail has no headings to open a group with: every entry shows.
  const rail = state === 'collapsed' && !isMobile;
  return groups.map((group) => {
    const menu = (
      <SidebarMenu>
        {group.items.map((item) => (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton
              tooltip={t(item.label)}
              // On a phone the menu is a sheet over the page: close it on any
              // tap of an entry. A click, not a change of path, so the entry
              // of the page the user is on closes it too (desktop ignores it).
              onClick={() => setOpenMobile(false)}
              render={
                <Link
                  to={item.to}
                  activeProps={{ 'data-active': true }}
                  activeOptions={{ exact: item.to === '/' }}
                />
              }
            >
              <item.icon />
              <span>{t(item.label)}</span>
            </SidebarMenuButton>
            {item.badge && <NavBadge useCount={item.badge} />}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
    // The first group (Dashboard, Inbox...) has no heading and never folds.
    if (group.id === 'home') {
      return (
        <SidebarGroup key={group.id} aria-label={t(group.label)}>
          {menu}
        </SidebarGroup>
      );
    }
    const open =
      rail ||
      (opened[group.id] ?? (group.id === 'workspace' || group.id === current));
    return (
      <Collapsible
        key={group.id}
        open={open}
        onOpenChange={(next) => toggle(group.id, next)}
        render={<SidebarGroup />}
      >
        <SidebarGroupLabel
          render={<CollapsibleTrigger />}
          className="w-full cursor-pointer justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {t(group.label)}
          <ChevronRightIcon
            aria-hidden
            className="transition-transform duration-150 in-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
        </SidebarGroupLabel>
        <CollapsibleContent>{menu}</CollapsibleContent>
      </Collapsible>
    );
  });
}

/** The count of an entry (`NavItem.badge`); a component, since it calls a hook. */
function NavBadge(props: { useCount: NonNullable<NavItem['badge']> }) {
  const count = props.useCount();
  // As the bell: past 99 the exact number stops helping (and a capped one is 1,000).
  return count ? (
    <SidebarMenuBadge>{count > 99 ? '99+' : count}</SidebarMenuBadge>
  ) : null;
}
