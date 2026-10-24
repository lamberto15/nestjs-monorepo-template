import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { useTheme } from '@nestjs-monorepo-template/ui/components/theme-provider';
import {
  BellIcon,
  DownloadIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  LanguagesIcon,
  LogOutIcon,
  PaletteIcon,
  ShieldCheckIcon,
  ShieldUserIcon,
  SlidersHorizontalIcon,
  UserIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { languages, type Language } from '@/i18n';
import { api } from '@/lib/api';
import { UserAvatar } from '@/components/user-avatar';
import { BuildInfo } from '@/components/build-info';
import { useMe } from '@/lib/features';
import { useInstallPrompt } from '@/lib/pwa';
import { meQuery, saveLanguageKey } from '@/lib/session';
import { useSignOut } from '@/lib/sign-out';

const themes = ['light', 'dark', 'system'] as const;

/** The signed-in user: their account, the preferences, signing out. */
export function NavUser() {
  const { isMobile } = useSidebar();
  const { t, i18n } = useTranslation();
  const { t: tn } = useTranslation('notifications');
  const { t: tw } = useTranslation('watching');
  const { t: tp } = useTranslation('pwa');
  const install = useInstallPrompt();
  const { theme, setTheme } = useTheme();
  const me = useMe();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  // The language is the account's (the API mails in it too): saved with
  // the profile, not only in this browser.
  const saveLanguage = useMutation({
    mutationKey: saveLanguageKey,
    mutationFn: (locale: Language) =>
      unwrap(api.PATCH('/v1/auth/me', { body: { locale } })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  });
  if (!me) {
    return null;
  }
  const { user } = me;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />
            }
          >
            <UserAvatar name={user.name} src={user.avatarUrl} />
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
            <ChevronsUpDownIcon className="ms-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? 'bottom' : i18n.dir() === 'rtl' ? 'left' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="grid text-start text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/account/profile" />}>
                <UserIcon />
                {t('account.profile.title')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/account/preferences" />}>
                <SlidersHorizontalIcon />
                {t('settings:preferences.title')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/account/security" />}>
                <ShieldCheckIcon />
                {t('account.security.title')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/account/notifications" />}>
                <BellIcon />
                {tn('preferences.title')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/account/watching" />}>
                <EyeIcon />
                {tw('title')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/account/privacy" />}>
                <ShieldUserIcon />
                {t('privacy:title')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <PaletteIcon />
                  {t('preferences.theme')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
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
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LanguagesIcon />
                  {t('preferences.language')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={i18n.language}
                    onValueChange={(value) => {
                      const language = languages.find((x) => x === value);
                      if (!language) {
                        return;
                      }
                      void i18n.changeLanguage(language);
                      if (!user.impersonator) {
                        saveLanguage.mutate(language);
                      }
                    }}
                  >
                    {languages.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {t(`languages.${value}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {install && (
              <DropdownMenuItem onClick={() => void install()}>
                <DownloadIcon />
                {tp('install')}
              </DropdownMenuItem>
            )}
            <BuildInfo />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              <LogOutIcon />
              {t('auth.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
