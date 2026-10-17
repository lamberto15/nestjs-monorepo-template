import { Link } from '@tanstack/react-router';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { useTranslation } from 'react-i18next';
import { nav } from '@/nav';

export function NavMain() {
  const { t } = useTranslation();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('nav.platform')}</SidebarGroupLabel>
      <SidebarMenu>
        {nav.map((item) => (
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
