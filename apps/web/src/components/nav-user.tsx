import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@nestjs-monorepo-template/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { useTheme } from '@nestjs-monorepo-template/ui/components/theme-provider';
import { ChevronsUpDownIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { languages, type Language } from '@/i18n';
import type { Session } from '@/lib/session';

const themes = ['light', 'dark', 'system'] as const;

/** The user (once there is a session) and the preferences: theme, language. */
export function NavUser({ session }: { session: Session }) {
  const { isMobile } = useSidebar();
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const name = session?.user.name ?? t('preferences.open');
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />
            }
          >
            <Avatar>
              <AvatarImage src={session?.user.avatar} alt={name} />
              <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">{name}</span>
              {session && (
                <span className="truncate text-xs">{session.user.email}</span>
              )}
            </div>
            <ChevronsUpDownIcon className="ms-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-fit"
            side={isMobile ? 'bottom' : i18n.dir() === 'rtl' ? 'left' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('preferences.theme')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value) =>
                  setTheme(themes.find((x) => x === value) ?? 'system')
                }
              >
                {themes.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {t(`preferences.${value}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('preferences.language')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={i18n.language}
                onValueChange={(value) =>
                  void i18n.changeLanguage(value as Language)
                }
              >
                {languages.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {t(`languages.${value}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
