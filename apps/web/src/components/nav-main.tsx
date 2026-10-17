import { Link } from '@tanstack/react-router';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { useTranslation } from 'react-i18next';
import { useFeatures, useMe, visible } from '@/lib/features';
import { nav } from '@/nav';

export function NavMain() {
  const { t } = useTranslation();
  // The one place the menu is filtered (UX only: the API enforces both).
  const items = visible(nav, useFeatures(), useMe()?.can);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('nav.platform')}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
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
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
