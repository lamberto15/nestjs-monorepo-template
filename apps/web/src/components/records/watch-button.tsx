import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { unwatchRecord, watchRecord } from '@/components/records/panels/api';
import { watchedKey, watchedQuery } from '@/features/watching/api';
import { useCan, type Permission } from '@/lib/features';
import { useListDescription } from '@/lib/list-query';

/**
 * Watch / Stop watching on a record's page, for any subject that takes the
 * `watch` capability (`GET /v1/lists/{subject}`, from its `<item>.record.ts`;
 * nothing is shown for one that does not, or to a user who may not read the
 * record):
 *
 *   <WatchButton subject="Invoice" path="/v1/invoices/{id}" id={invoice.id} />
 *
 * `path` is the record's route with `{id}`; the toggle calls its
 * `POST`/`DELETE …/watch`. The record carries no "watching" flag, so the state
 * is `GET /v1/subscriptions?subject=&recordId=` (features/watching), shared
 * with the "Watching" list.
 */
export function WatchButton(props: {
  subject: string;
  path: `${string}/{id}`;
  id: string;
}) {
  const { t } = useTranslation('watching');
  const queryClient = useQueryClient();
  const canRead = useCan(`${props.subject}.read` as Permission);
  const description = useListDescription(props.subject, canRead).data;
  const takesWatch = canRead && description?.capabilities.watch === true;
  const watched = useQuery({
    ...watchedQuery(props.subject, props.id),
    enabled: takesWatch,
  });

  const toggle = useMutation({
    mutationFn: (watch: boolean) =>
      watch
        ? watchRecord(props.path, props.id)
        : unwatchRecord(props.path, props.id),
    onSuccess: async (_data, watch) => {
      // A refetch already in flight would bring the state from before.
      await queryClient.cancelQueries({
        queryKey: watchedKey(props.subject, props.id),
      });
      queryClient.setQueryData(watchedKey(props.subject, props.id), watch);
      void queryClient.invalidateQueries({ queryKey: ['watching', 'list'] });
      toast.success(t(watch ? 'watching' : 'stopped'));
    },
    // A failed toggle (a 404: it was not watched after all) shows what is true.
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: watchedKey(props.subject, props.id),
      }),
  });

  if (!takesWatch || watched.data === undefined) {
    return null;
  }
  const watch = !watched.data;
  return (
    <Button
      type="button"
      variant="outline"
      disabled={toggle.isPending}
      title={t(watched.data ? 'hintOn' : 'hintOff')}
      onClick={() => toggle.mutate(watch)}
    >
      {toggle.isPending ? (
        <Spinner />
      ) : watched.data ? (
        <EyeOffIcon />
      ) : (
        <EyeIcon />
      )}
      {t(watched.data ? 'stop' : 'watch')}
    </Button>
  );
}
