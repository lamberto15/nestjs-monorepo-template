import { useIsMutating, useQuery } from '@tanstack/react-query';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { Separator } from '@nestjs-monorepo-template/ui/components/separator';
import { TooltipProvider } from '@nestjs-monorepo-template/ui/components/tooltip';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSidebar } from '@/components/app-sidebar';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { SearchPalette } from '@/features/search/palette';
import { NotificationsBell } from '@/features/notifications/bell';
import { languages } from '@/i18n';
import { RealtimeProvider } from '@/lib/realtime';
import { meQuery, saveLanguageKey } from '@/lib/session';

// The signed-in app. Nobody signed in: to sign-in, and back here afterwards.
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.session.me();
    if (!me) {
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      });
    }
    // A tenant that requires two-factor restricts the session until the
    // user sets it up (403 `mfa_enrollment_required` elsewhere).
    if (me.mfaEnrollmentRequired && location.pathname !== '/account/security') {
      throw redirect({ to: '/account/security' });
    }
    return { me };
  },
  component: AppLayout,
});

function AppLayout() {
  useSavedLanguage();
  return (
    <TooltipProvider>
      <RealtimeProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <ImpersonationBanner />
            <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger className="-ms-1" />
              <Separator
                orientation="vertical"
                className="me-2 data-[orientation=vertical]:h-4"
              />
              <div className="ms-auto flex items-center gap-1">
                <SearchPalette />
                <NotificationsBell />
              </div>
            </header>
            <main className="flex flex-1 flex-col gap-4 p-4">
              <Outlet />
            </main>
          </SidebarInset>
        </SidebarProvider>
      </RealtimeProvider>
    </TooltipProvider>
  );
}

/**
 * The language the user saved in their profile wins over the browser's.
 * While a language from the menu is being saved, `me` may still carry an
 * older one (the refetch after the first of two quick switches): ignored
 * until the last save settled, which refetches `me` before it does.
 */
function useSavedLanguage() {
  const { i18n } = useTranslation();
  const locale = useQuery(meQuery).data?.user.locale;
  const saving = useIsMutating({ mutationKey: saveLanguageKey }) > 0;
  useEffect(() => {
    if (saving) {
      return;
    }
    const language = languages.find((value) => value === locale);
    if (language && language !== i18n.language) {
      void i18n.changeLanguage(language);
    }
  }, [locale, saving, i18n]);
}
