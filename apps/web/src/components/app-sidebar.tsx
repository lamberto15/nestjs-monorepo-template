import { useRouteContext } from '@tanstack/react-router';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { useTranslation } from 'react-i18next';
import { NavMain } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';

export function AppSidebar() {
  const { t, i18n } = useTranslation();
  const { session } = useRouteContext({ from: '/_app' });
  return (
    <Sidebar collapsible="icon" side={i18n.dir() === 'rtl' ? 'right' : 'left'}>
      <SidebarHeader>
        <span className="px-2 py-1 text-sm font-semibold">{t('app.name')}</span>
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
      </SidebarContent>
      <SidebarFooter>
        <NavUser session={session} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
