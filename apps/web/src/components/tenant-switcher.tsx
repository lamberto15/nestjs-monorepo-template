import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import {
  CheckIcon,
  ChevronsUpDownIcon,
  GalleryVerticalEndIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useBranding } from '@/lib/branding';
import { useFeatures, useMe } from '@/lib/features';
import { createSession, tenantsQuery } from '@/lib/session';

/**
 * `POST /v1/auth/tenant` re-issues the session in another of the user's
 * tenants (a new cookie): nothing cached belongs to it any more.
 */
export function useSwitchTenant() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useMutation({
    // 204: no body to unwrap (an error is thrown as ApiError either way).
    mutationFn: async (tenantId: string) => {
      await api.POST('/v1/auth/tenant', { body: { tenantId } });
    },
    onSuccess: async () => {
      await createSession(queryClient).reset();
      // The session changed already: a form's unsaved-changes guard would
      // hold a page of the previous one (lib/unsaved-changes.ts).
      await router.navigate({ to: '/', ignoreBlocker: true });
      await router.invalidate();
    },
  });
}

/**
 * The tenant the session acts in, and the others to switch to: shadcn's
 * sidebar-07 team switcher. `POST /v1/auth/tenant` re-issues the session in
 * the other tenant (a new cookie): nothing cached belongs to it any more.
 * Without a choice (TENANCY=single, one membership, an impersonation) it is
 * a plain heading.
 */
export function TenantSwitcher() {
  const { t, i18n } = useTranslation();
  const { isMobile } = useSidebar();
  const me = useMe();
  const features = useFeatures();
  const choosing = features?.tenancy === 'multi' && !me?.user.impersonator;
  const tenants = useQuery({ ...tenantsQuery, enabled: choosing });
  const switchTenant = useSwitchTenant();
  const logoUrl = useBranding()?.logoUrl;

  const current = me?.tenant;
  const items = tenants.data?.items ?? [];
  const heading = (
    <>
      <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
        {logoUrl ? (
          // The tenant's logo (docs/branding.md); decorative, the name is beside it.
          <img src={logoUrl} alt="" className="size-full object-contain" />
        ) : (
          <GalleryVerticalEndIcon className="size-4" />
        )}
      </div>
      <div className="grid flex-1 text-start text-sm leading-tight">
        <span className="truncate font-medium">{t('app.name')}</span>
        {current && <span className="truncate text-xs">{current.name}</span>}
      </div>
    </>
  );

  if (!choosing || items.length < 2) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" className="pointer-events-none">
            {heading}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                aria-label={t('auth.tenants.switch')}
              />
            }
          >
            {heading}
            <ChevronsUpDownIcon className="ms-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-fit"
            align="start"
            side={isMobile ? 'bottom' : i18n.dir() === 'rtl' ? 'left' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t('auth.tenants.title')}
              </DropdownMenuLabel>
              {items.map((tenant) => (
                <DropdownMenuItem
                  key={tenant.id}
                  disabled={switchTenant.isPending}
                  onClick={() => {
                    if (!tenant.current) {
                      switchTenant.mutate(tenant.id);
                    }
                  }}
                  className="gap-2 p-2"
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    {tenant.name.slice(0, 1).toUpperCase()}
                  </div>
                  {tenant.name}
                  {tenant.current && <CheckIcon className="ms-auto size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
