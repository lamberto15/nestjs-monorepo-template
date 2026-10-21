import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { unwatchRecord, watchRecord } from '@/components/records/panels/api';
import { useCan, type Permission } from '@/lib/features';
import { useListDescription } from '@/lib/list-query';
import { useWritesPaused } from '@/lib/mode';
import { recordKeys } from '@/lib/records';

/**
 * Watch / Stop watching on a record's page, for any subject that takes the
 * `watch` capability (`GET /v1/lists/{subject}`, from its `<item>.record.ts`;
 * nothing is shown for one that does not, or to a user who may not read the
 * record):
 *
 *   <WatchButton
 *     subject="Invoice"
 *     path="/v1/invoices/{id}"
 *     id={invoice.id}
 *     watching={invoice.watching}
 *     onToggled={(watching) => setInvoiceWatching(queryClient, invoice.id, watching)}
 *   />
 *
 * `path` is the record's route with `{id}`; the toggle calls its
 * `POST`/`DELETE …/watch`. The state is the record's own `watching`, which the
 * page reads with `?include=can,watching` (only for a subject with the `watch`
 * capability: any other answers 400): no request of its own. Nothing is shown
 * while `watching` is undefined. After a toggle `onToggled` lets the page set
 * the new `watching` on its cached record; the "Watching" list is refreshed here.
 */
export function WatchButton(props: {
  subject: string;
  path: `${string}/{id}`;
  id: string;
  /** The record's `watching` (`?include=watching`). */
  watching: boolean | undefined;
  /** Puts the new state on the page's cached record. */
  onToggled: (watching: boolean) => void;
}) {
  const { t } = useTranslation('watching');
  const queryClient = useQueryClient();
  const paused = useWritesPaused();
  const canRead = useCan(`${props.subject}.read` as Permission);
  const description = useListDescription(props.subject, canRead).data;
  const takesWatch = canRead && description?.capabilities.watch === true;
  // The record's query key, from its route (`/v1/notes/{id}` is `/v1/notes`).
  const listPath = props.path.slice(0, -'/{id}'.length);

  const toggle = useMutation({
    mutationFn: (watch: boolean) =>
      watch
        ? watchRecord(props.path, props.id)
        : unwatchRecord(props.path, props.id),
    onSuccess: async (_data, watch) => {
      // A refetch already in flight would bring the state from before.
      await queryClient.cancelQueries({
        queryKey: recordKeys.detail(listPath, props.id),
      });
      props.onToggled(watch);
      void queryClient.invalidateQueries({ queryKey: ['watching', 'list'] });
      toast.success(t(watch ? 'watching' : 'stopped'));
    },
    // A failed toggle (a 404: it was not watched after all) shows what is true.
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: recordKeys.detail(listPath, props.id),
      }),
  });

  if (!takesWatch || props.watching === undefined) {
    return null;
  }
  const watch = !props.watching;
  return (
    <Button
      type="button"
      variant="outline"
      disabled={toggle.isPending || paused}
      title={t(props.watching ? 'hintOn' : 'hintOff')}
      onClick={() => toggle.mutate(watch)}
    >
      {toggle.isPending ? (
        <Spinner />
      ) : props.watching ? (
        <EyeOffIcon />
      ) : (
        <EyeIcon />
      )}
      {t(props.watching ? 'stop' : 'watch')}
    </Button>
  );
}
