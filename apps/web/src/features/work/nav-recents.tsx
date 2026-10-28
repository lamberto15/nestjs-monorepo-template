import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { normalizeRedirect } from '@/lib/safe-redirect';
import type { NavGroup } from '@/nav';
import { recentsQuery, useClearRecents } from './api';

/**
 * The sidebar's Recent group: records the person opened lately, each under
 * the menu entry its subject's read permission gates (as favorites are
 * placed); hidden while there are none. "Clear history" empties the list.
 */
export function NavRecents(props: { groups: readonly NavGroup[] }) {
  const { t } = useTranslation('work');
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const clear = useClearRecents();
  const recents = useQuery(recentsQuery).data?.items ?? [];
  const entries = props.groups.flatMap((group) => group.items);
  const placed = recents.flatMap((recent) => {
    const entry = entries.find((item) =>
      ([] as readonly string[])
        .concat(item.permission ?? [])
        .includes(`${recent.subject}.read`),
    );
    const path = entry && normalizeRedirect(`${entry.to}/${recent.recordId}`);
    return entry && path ? [{ recent, entry, path }] : [];
  });
  if (placed.length === 0) {
    return null;
  }
  return (
    <SidebarGroup aria-label={t('recents.group')}>
      <SidebarGroupLabel>{t('recents.group')}</SidebarGroupLabel>
      <SidebarGroupAction
        title={t('recents.clear')}
        aria-label={t('recents.clear')}
        disabled={clear.isPending}
        onClick={() => clear.mutate()}
      >
        <Trash2Icon />
      </SidebarGroupAction>
      <SidebarMenu>
        {placed.map(({ recent, entry, path }) => (
          <SidebarMenuItem key={recent.id}>
            <SidebarMenuButton
              tooltip={recent.label}
              render={
                <a
                  href={path}
                  onClick={(event) => {
                    event.preventDefault();
                    setOpenMobile(false);
                    router.history.push(path);
                  }}
                />
              }
            >
              <entry.icon />
              <span>{recent.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
