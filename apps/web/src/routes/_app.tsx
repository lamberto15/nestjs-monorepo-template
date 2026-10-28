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
import {
  MAIN_CONTENT_ID,
  SkipToContent,
} from '@/components/route-accessibility';
import { AppSidebar } from '@/components/app-sidebar';
import { BottomNav } from '@/components/bottom-nav';
import { HeaderBreadcrumb } from '@/components/header-breadcrumb';
import { BreachedPasswordBanner } from '@/components/breached-password-banner';
import { OfflineBanner } from '@/components/offline-banner';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { MaintenanceNotice } from '@/components/maintenance-notice';
import { ModeBanner } from '@/components/mode-banner';
import { SessionIdleWarning } from '@/components/session-idle-warning';
import { UnverifiedBanner } from '@/components/unverified-banner';
import { SearchPalette } from '@/features/search/palette';
import { NotificationsBell } from '@/features/notifications/bell';
import { languages } from '@/i18n';
import { BrandTheme } from '@/lib/branding';
import { useModeWatch } from '@/lib/mode';
import { RealtimeProvider } from '@/lib/realtime';
import { featuresQuery, meQuery, saveLanguageKey } from '@/lib/session';

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
    // The first administrator must replace the placeholder email and the
    // generated password first (403 `onboarding_required` elsewhere). The
    // onboarding page also offers two-factor, so it comes before the next
    // rule: both pending, it is where the user is, not sent back and forth.
    if (me.onboardingRequired && location.pathname !== '/onboarding') {
      throw redirect({ to: '/onboarding' });
    }
    // A tenant that requires two-factor restricts the session until the
    // user sets it up (403 `mfa_enrollment_required` elsewhere).
    if (
      me.mfaEnrollmentRequired &&
      location.pathname !== '/account/security' &&
      location.pathname !== '/onboarding'
    ) {
      throw redirect({ to: '/account/security' });
    }
    // The deployment's mode comes with the switches: known before the first
    // paint, so a deployment in maintenance never flashes a page of failed
    // requests. A failure is no reason to hold the app back (the layout asks
    // again, and the error handler says what went wrong).
    await context.queryClient
      .ensureQueryData(featuresQuery)
      .catch(() => undefined);
    return { me };
  },
  component: AppLayout,
});

/**
 * Whether the sidebar starts expanded: the choice it kept in its cookie
 * (`SIDEBAR_COOKIE_NAME` in the generated sidebar, written when the user
 * collapses or expands it). Next.js apps read it on the server; this app has
 * none, so the browser does. Expanded when there is none or it can't be read.
 */
function savedSidebarOpen() {
  try {
    return !document.cookie.split('; ').includes('sidebar_state=false');
  } catch {
    // cookies refused (a sandboxed frame): no saved choice
    return true;
  }
}

function AppLayout() {
  useSavedLanguage();
  const mode = useModeWatch();
  // Maintenance: the API refuses everything, so no page, menu or socket
  // would work; one notice instead (it asks nothing but the mode).
  if (mode === 'maintenance') {
    return <MaintenanceNotice />;
  }
  return (
    <TooltipProvider>
      {/* Before the menu: the keyboard's way straight to the page. */}
      <SkipToContent />
      {/* The tenant's colour on the theme; read again after a tenant switch. */}
      <BrandTheme />
      <RealtimeProvider>
        {/* Only its starting state: the provider keeps its own after that. */}
        <SidebarProvider defaultOpen={savedSidebarOpen()}>
          <AppSidebar />
          {/* min-w-0: a flex child doesn't shrink below its content, so a wide
              table would widen the page past the window instead of scrolling
              in its own box. */}
          <SidebarInset className="min-w-0">
            <OfflineBanner />
            <ImpersonationBanner />
            <ModeBanner />
            <SessionIdleWarning />
            <UnverifiedBanner />
            <BreachedPasswordBanner />
            <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger className="-ms-1" />
              <Separator
                orientation="vertical"
                className="me-2 data-[orientation=vertical]:h-4"
              />
              <HeaderBreadcrumb />
              <div className="ms-auto flex items-center gap-1">
                <SearchPalette />
                <NotificationsBell />
              </div>
            </header>
            {/* SidebarInset is the page's <main> already: one landmark. */}
            <div
              id={MAIN_CONTENT_ID}
              tabIndex={-1}
              className="flex flex-1 flex-col gap-4 p-4 outline-none max-md:pb-24"
            >
              <Outlet />
            </div>
          </SidebarInset>
          <BottomNav />
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
