import { Outlet, createFileRoute } from '@tanstack/react-router';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { Separator } from '@nestjs-monorepo-template/ui/components/separator';
import { TooltipProvider } from '@nestjs-monorepo-template/ui/components/tooltip';
import { AppSidebar } from '@/components/app-sidebar';

// The layout of the signed-in app (the sign-in change guards it with
// context.session in beforeLoad).
export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ms-1" />
            <Separator
              orientation="vertical"
              className="me-2 data-[orientation=vertical]:h-4"
            />
          </header>
          <main className="flex flex-1 flex-col gap-4 p-4">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
