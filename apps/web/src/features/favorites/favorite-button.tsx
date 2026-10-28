import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { cn } from '@nestjs-monorepo-template/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { StarIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCan, type Permission } from '@/lib/features';
import { useListDescription } from '@/lib/list-query';
import {
  favoritesQuery,
  findFavorite,
  useAddFavorite,
  useRemoveFavorite,
  type NewFavorite,
} from './api';

/**
 * A star that pins or unpins something in the person's favorites (the
 * sidebar's Favorites group): a record on its page, a list page, or a saved
 * view. A record's star shows only for a subject whose records can be
 * watched (the `watch` capability: the API checks a favorite as watching
 * does), to whoever may read it:
 *
 *   <FavoriteButton kind="record" subject="Invoice" target={invoice.id} label={invoice.number} />
 */
export function FavoriteButton(props: NewFavorite) {
  const { t } = useTranslation('favorites');
  const record = props.kind === 'record';
  const canRead = useCan(`${props.subject}.read` as Permission);
  const description = useListDescription(
    props.subject ?? '',
    record && canRead,
  ).data;
  const favorites = useQuery(favoritesQuery);
  const add = useAddFavorite();
  const remove = useRemoveFavorite();
  if (record && !(canRead && description?.capabilities.watch === true)) {
    return null;
  }
  const pinned = findFavorite(favorites.data?.items, props);
  const busy = favorites.isPending || add.isPending || remove.isPending;
  const toggle = () => {
    const done = () =>
      toast.success(t(pinned ? 'removed' : 'added', { label: props.label }));
    if (pinned) {
      remove.mutate(pinned.id, { onSuccess: done });
    } else {
      add.mutate(props, { onSuccess: done });
    }
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-pressed={pinned !== undefined}
      aria-label={t(pinned ? 'remove' : 'add', { label: props.label })}
      title={t(pinned ? 'remove' : 'add', { label: props.label })}
      disabled={busy}
      onClick={toggle}
    >
      <StarIcon
        aria-hidden
        className={cn(pinned && 'fill-current text-amber-500')}
      />
    </Button>
  );
}
