import { Link } from '@tanstack/react-router';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { useTranslation } from 'react-i18next';
import { useOperator } from '@/features/tenants/queries';
import { useFeatures, useMe } from '@/lib/features';
import { nav, visibleGroups, type NavItem } from '@/nav';

export function NavMain() {
  const { t } = useTranslation();
  // The one place the menu is filtered (UX only: the API enforces both).
  const me = useMe();
  const groups = visibleGroups(
    nav,
    useFeatures(),
    me?.can,
    useOperator(),
    me?.tenant?.operator === true,
  );
  return groups.map((group) => (
    <SidebarGroup key={group.id}>
      <SidebarGroupLabel>{t(group.label)}</SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map((item) => (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton
              tooltip={t(item.label)}
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
    </SidebarGroup>
  ));
}

/** The count of an entry (`NavItem.badge`); a component, since it calls a hook. */
function NavBadge(props: { useCount: NonNullable<NavItem['badge']> }) {
  const count = props.useCount();
  return count ? <SidebarMenuBadge>{count}</SidebarMenuBadge> : null;
}
