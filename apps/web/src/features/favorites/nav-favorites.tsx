import { useQuery } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@nestjs-monorepo-template/ui/components/sheet';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
} from '@nestjs-monorepo-template/ui/components/sortable';
import {
  ArrowUpDownIcon,
  GripVerticalIcon,
  StarIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeRedirect } from '@/lib/safe-redirect';
import { useSortableProps } from '@/lib/sortable';
import { activeEntry, type NavGroup, type NavItem } from '@/nav';
import {
  favoritesQuery,
  useRemoveFavorite,
  useReorderFavorites,
  type Favorite,
} from './api';

/** Where a favorite leads, and the menu entry it belongs to (its icon). */
type Placed = { favorite: Favorite; path: string; entry: NavItem };

/**
 * Where each favorite opens, through the menu the user sees: a record under
 * the entry its subject's read permission gates (`Note.read`: `/notes`),
 * a page or a view's list where it is in the menu. One the menu no longer
 * shows is left out (the API leaves out what the user may not see).
 */
function place(favorite: Favorite, groups: readonly NavGroup[]) {
  const entries = groups.flatMap((group) => group.items);
  let entry: NavItem | undefined;
  let path: string | undefined;
  if (favorite.kind === 'record') {
    const read = `${favorite.subject}.read`;
    entry = entries.find((item) =>
      ([] as readonly string[]).concat(item.permission ?? []).includes(read),
    );
    path = entry && `${entry.to}/${favorite.target}`;
  } else {
    const page = favorite.kind === 'page' ? favorite.target : favorite.subject;
    entry = activeEntry(groups, page)?.item;
    path =
      favorite.kind === 'page'
        ? page
        : `${page}?view=${encodeURIComponent(favorite.target)}`;
  }
  const safe = normalizeRedirect(path);
  return entry && safe ? { favorite, path: safe, entry } : undefined;
}

/** The sidebar's Favorites group (`groups`: the menu the user sees); hidden while there are none. */
export function NavFavorites(props: { groups: readonly NavGroup[] }) {
  const { t } = useTranslation('favorites');
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const location = useRouterState({
    select: (s) => s.location.pathname + s.location.searchStr,
  });
  const favorites = useQuery(favoritesQuery).data?.items ?? [];
  const [managing, setManaging] = useState(false);
  const placed = favorites
    .map((favorite) => place(favorite, props.groups))
    .filter((item): item is Placed => item !== undefined);
  if (placed.length === 0) {
    return null;
  }
  return (
    <SidebarGroup aria-label={t('group')}>
      <SidebarGroupLabel>{t('group')}</SidebarGroupLabel>
      <SidebarGroupAction
        title={t('manage')}
        aria-label={t('manage')}
        onClick={() => setManaging(true)}
      >
        <ArrowUpDownIcon />
      </SidebarGroupAction>
      <SidebarMenu>
        {placed.map(({ favorite, path, entry }) => (
          <SidebarMenuItem key={favorite.id}>
            <SidebarMenuButton
              tooltip={favorite.label}
              isActive={location === path}
              render={
                // A link the router follows (its path is data, not a route).
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
              <span>{favorite.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
      <ManageFavorites
        open={managing}
        onOpenChange={setManaging}
        favorites={favorites}
      />
    </SidebarGroup>
  );
}

/** Reorder (drag, or Space and the arrows on a handle) and unpin favorites. */
function ManageFavorites(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  favorites: Favorite[];
}) {
  const { t } = useTranslation('favorites');
  const reorder = useReorderFavorites();
  const remove = useRemoveFavorite();
  const sortable = useSortableProps(
    props.favorites.length,
    (id) => props.favorites.find((f) => f.id === id)?.label ?? String(id),
  );
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('manageTitle')}</SheetTitle>
          <SheetDescription>{t('manageHint')}</SheetDescription>
        </SheetHeader>
        <Sortable
          {...sortable}
          value={props.favorites}
          getItemValue={(favorite) => favorite.id}
          onValueChange={(next) => reorder.mutate(next)}
        >
          <SortableContent
            render={
              <ul
                aria-label={t('group')}
                className="flex flex-col gap-2 px-4"
              />
            }
          >
            {props.favorites.map((favorite) => (
              <SortableItem
                key={favorite.id}
                value={favorite.id}
                render={
                  <li className="flex items-center gap-2 rounded-md border bg-card p-2" />
                }
              >
                <SortableItemHandle
                  aria-label={t('reorder', { label: favorite.label })}
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 max-md:size-11"
                    />
                  }
                >
                  <GripVerticalIcon />
                </SortableItemHandle>
                <StarIcon
                  aria-hidden
                  className="size-4 shrink-0 fill-current text-amber-500"
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {favorite.label}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('unpin', { label: favorite.label })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(favorite.id)}
                >
                  <XIcon />
                </Button>
              </SortableItem>
            ))}
          </SortableContent>
        </Sortable>
      </SheetContent>
    </Sheet>
  );
}
