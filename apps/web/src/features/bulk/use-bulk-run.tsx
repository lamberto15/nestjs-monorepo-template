import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLivePoll, useRealtimeEvent, withProgress } from '@/lib/realtime';
import {
  bulkJobQuery,
  runBulk,
  type BulkBody,
  type BulkOutcome,
  type BulkPath,
  type BulkResult,
} from './api';

/** The items listed under a finished run; the counts are exact. */
const SHOWN_ITEMS = 20;

interface View {
  status: 'queued' | 'running' | 'completed' | 'failed';
  processed: number;
  done: number;
  failed: number;
  result?: BulkResult;
  error?: string;
}

/**
 * Starts a bulk run (`POST /v1/<x>/bulk`) and shows it: a short run answers
 * at once, a larger one (or a filter run) is a job followed at
 * `GET /v1/bulk/{id}`. When it ends the lists are refetched and `onFinished`
 * is called (the caller clears its selection).
 */
export function useBulkRun(path: BulkPath) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<BulkBody['action']>();
  const finishedRef = useRef<() => void>(undefined);
  const mutation = useMutation({
    mutationFn: (body: BulkBody) => runBulk(path, body),
    // The dialog is not the place for a refused start: the global toast says it.
    onError: () => setOpen(false),
  });

  const start = (body: BulkBody, onFinished?: () => void) => {
    finishedRef.current = onFinished;
    setAction(body.action);
    setOpen(true);
    mutation.reset();
    mutation.mutate(body);
  };

  const finished = () => {
    void queryClient.invalidateQueries({ queryKey: ['list'] });
    finishedRef.current?.();
    finishedRef.current = undefined;
  };

  const dialog = (
    <BulkRunDialog
      open={open}
      action={action}
      outcome={mutation.data}
      starting={mutation.isPending}
      onFinished={finished}
      onClose={() => setOpen(false)}
    />
  );
  return { start, dialog, busy: mutation.isPending };
}

function BulkRunDialog(props: {
  open: boolean;
  action?: BulkBody['action'];
  outcome?: BulkOutcome;
  starting: boolean;
  onFinished: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('bulk');
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {props.action ? t(`run.title.${props.action}`) : ''}
          </DialogTitle>
          <DialogDescription>{t('run.description')}</DialogDescription>
        </DialogHeader>
        {props.starting || !props.outcome ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Spinner />
            {t('run.starting')}
          </p>
        ) : props.outcome.kind === 'done' ? (
          <RunView
            view={{
              status: 'completed',
              processed: props.outcome.result.results.length,
              done: props.outcome.result.done,
              failed: props.outcome.result.failed,
              result: props.outcome.result,
            }}
            onFinished={props.onFinished}
          />
        ) : (
          <JobView id={props.outcome.id} onFinished={props.onFinished} />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            {t('run.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A queued run: its end comes as `bulk.finished` or `bulk.failed` for this id
 * (the query is refetched) and its progress as `bulk.progress`; it is polled
 * every second only when there is no connected socket (useLivePoll).
 */
function JobView(props: { id: string; onFinished: () => void }) {
  const queryClient = useQueryClient();
  const poll = useLivePoll(1000);
  const query = useQuery({
    ...bulkJobQuery(props.id, (status) =>
      poll.interval([{ id: props.id, status }]),
    ),
    meta: { errorToast: false },
  });
  const ended = (event: { id: string }) => {
    if (event.id !== props.id) {
      return;
    }
    poll.push(props.id);
    void queryClient.invalidateQueries({
      queryKey: bulkJobQuery(props.id).queryKey,
    });
  };
  useRealtimeEvent('bulk.finished', ended);
  useRealtimeEvent('bulk.failed', ended);
  useRealtimeEvent('bulk.progress', (event) => {
    if (event.id !== props.id) {
      return;
    }
    queryClient.setQueryData(
      bulkJobQuery(props.id).queryKey,
      (job) =>
        job &&
        withProgress(job, {
          processed: event.processed,
          done: event.done,
          failed: event.failed,
        }),
    );
  });
  const { t } = useTranslation('bulk');
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('run.error')}
      </p>
    );
  }
  const job = query.data;
  return (
    <RunView
      onFinished={props.onFinished}
      view={{
        status: job?.status ?? 'queued',
        processed: job?.progress.processed ?? 0,
        done: job?.progress.done ?? 0,
        failed: job?.progress.failed ?? 0,
        result: job?.result,
        error: job?.error,
      }}
    />
  );
}

function RunView(props: { view: View; onFinished: () => void }) {
  const { t } = useTranslation('bulk');
  const { view } = props;
  const ended = view.status === 'completed' || view.status === 'failed';
  const notified = useRef(false);
  const { onFinished } = props;
  useEffect(() => {
    if (ended && !notified.current) {
      notified.current = true;
      onFinished();
    }
  }, [ended, onFinished]);

  if (!ended) {
    return (
      <Progress
        value={null}
        aria-label={t('run.progressLabel')}
        className="flex-col"
      >
        <p role="status" className="text-sm text-muted-foreground">
          {view.status === 'queued'
            ? t('run.queued')
            : t('run.progress', {
                processed: view.processed,
                done: view.done,
                failed: view.failed,
              })}
        </p>
      </Progress>
    );
  }
  const result = view.result;
  const problems = (result?.results ?? []).filter((r) => r.status !== 'done');
  return (
    <div className="flex flex-col gap-3">
      {view.status === 'failed' && (
        <Alert variant="destructive" role="alert">
          <CircleAlertIcon />
          <AlertDescription>{view.error ?? t('run.failed')}</AlertDescription>
        </Alert>
      )}
      <p role="status" className="text-sm font-medium">
        {t('run.result', {
          done: result?.done ?? view.done,
          failed: result?.failed ?? view.failed,
          skipped: result?.skipped ?? 0,
        })}
      </p>
      {problems.length > 0 && (
        <ul
          aria-label={t('run.problems')}
          className="flex max-h-48 flex-col gap-1 overflow-y-auto text-xs"
        >
          {problems.slice(0, SHOWN_ITEMS).map((item) => (
            <li key={item.id} className="rounded border p-2">
              <span className="font-mono">{item.id.slice(0, 8)}</span>{' '}
              <span className="text-muted-foreground">
                {t(`run.item.${item.status}`)}
              </span>
              {item.error && <span>: {item.error.message}</span>}
            </li>
          ))}
        </ul>
      )}
      {problems.length > SHOWN_ITEMS && (
        <p className="text-xs text-muted-foreground">
          {t('run.more', { count: problems.length - SHOWN_ITEMS })}
        </p>
      )}
    </div>
  );
}
