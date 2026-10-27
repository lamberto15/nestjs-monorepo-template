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
import { TenantSwitcher } from '@/components/tenant-switcher';

export function AppSidebar() {
  const { t, i18n } = useTranslation();
  return (
    <Sidebar collapsible="icon" side={i18n.dir() === 'rtl' ? 'right' : 'left'}>
      {/*
        Landmarks (axe "region": all content belongs to one): the sidebar is
        a complementary region, and its menu a navigation inside it. The
        generated Sidebar has no element prop for either, so both wrap its
        parts here, as flex columns that keep its layout.
      */}
      <aside
        aria-label={t('nav.sidebar')}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SidebarHeader>
          <TenantSwitcher />
        </SidebarHeader>
        <nav
          aria-label={t('nav.menu')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SidebarContent>
            <NavMain />
          </SidebarContent>
        </nav>
        <SidebarFooter>
          <NavUser />
        </SidebarFooter>
        <SidebarRail />
      </aside>
    </Sidebar>
  );
}
