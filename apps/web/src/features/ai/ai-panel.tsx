import { isApiError } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon, SparklesIcon, TagIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  aiKeys,
  aiOffQuery,
  aiRunQuery,
  asClassification,
  asSummary,
  isOver,
  requestAiRun,
  type AiTask,
} from '@/features/ai/api';
import { errorMessage } from '@/lib/errors';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime';

/** One run: pending while it is queued or running, then its answer or why it failed. */
function AiRunView(props: { id: string; task: AiTask }) {
  const { t } = useTranslation('ai');
  const queryClient = useQueryClient();
  const live = useRealtime() !== undefined;
  const query = useQuery({
    ...aiRunQuery(props.id),
    meta: { errorToast: false },
    // The events settle it; the poll is the fallback (slower with a socket).
    refetchInterval: (q) =>
      isOver(q.state.data) ? false : live ? 10_000 : 1500,
  });
  const settle = (event: { id: string }) => {
    if (event.id === props.id) {
      void queryClient.invalidateQueries({ queryKey: aiKeys.run(props.id) });
    }
  };
  useRealtimeEvent('ai.ready', settle);
  useRealtimeEvent('ai.failed', settle);
  // The event comes just before the answer is stored: `running` until then
  // (docs/ai.md), so a refetch that still sees it running is polled again.
  const run = query.data;

  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlertIcon />
        <AlertDescription>{t('run.error')}</AlertDescription>
      </Alert>
    );
  }
  if (!run || !isOver(run)) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner />
        {t(`pending.${props.task}`)}
      </p>
    );
  }
  if (run.status === 'failed') {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlertIcon />
        <AlertDescription>{run.error ?? t('run.failed')}</AlertDescription>
      </Alert>
    );
  }
  const summary =
    props.task === 'summarize' ? asSummary(run.output) : undefined;
  const classification =
    props.task === 'classify' ? asClassification(run.output) : undefined;
  if (!summary && !classification) {
    // The answer is kept an hour; or it is not the shape the task promises.
    return <p className="text-sm text-muted-foreground">{t('run.expired')}</p>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      {summary && (
        <>
          <p className="font-medium">{t('result.summary')}</p>
          {/* Plain text, never Markdown or HTML: the model's words are data. */}
          <p className="whitespace-pre-wrap">{summary.summary}</p>
          {summary.keyPoints.length > 0 && (
            <>
              <p className="font-medium">{t('result.keyPoints')}</p>
              <ul className="list-disc ps-5">
                {summary.keyPoints.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {classification && (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">{t('result.sentiment')}</dt>
            <dd>
              <Badge variant="outline">
                {t(`sentiment.${classification.sentiment}`)}
              </Badge>
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">{t('result.topic')}</dt>
            <dd>
              <Badge variant="secondary">{classification.topic}</Badge>
            </dd>
          </div>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">{t('result.notice')}</p>
    </div>
  );
}

/**
 * Summarize and Classify for a record (docs/ai.md): `source` is the name the
 * feature registered (`note`). A click asks for a run (202), then the run is
 * followed over realtime (`ai.ready`, `ai.failed`) and a slow poll. The
 * documented errors are handled here: 403 `ai_disabled` and 503
 * `ai_unavailable` replace the buttons with a notice, 409 `ai_pending` and
 * 429 `ai_quota_exceeded` are toasts. Hidden when an administrator's view of
 * `GET /v1/settings` shows `ai.enabled` off.
 *
 *   <AiPanel source="note" recordId={note.id} />
 */
export function AiPanel(props: { source: string; recordId: string }) {
  const { t } = useTranslation('ai');
  const off = useQuery(aiOffQuery).data === true;
  const [runs, setRuns] = useState<Partial<Record<AiTask, string>>>({});
  const [blocked, setBlocked] = useState<'disabled' | 'unavailable'>();
  const [asking, setAsking] = useState<AiTask>();

  const ask = useMutation({
    mutationFn: (task: AiTask) =>
      requestAiRun({ source: props.source, recordId: props.recordId, task }),
    meta: { errorToast: false },
    onMutate: (task) => setAsking(task),
    onSettled: () => setAsking(undefined),
    onSuccess: (started, task) =>
      setRuns((current) => ({ ...current, [task]: started.id })),
    onError: (error) => {
      const code = isApiError(error) ? error.code : undefined;
      if (code === 'ai_disabled') {
        setBlocked('disabled');
      } else if (code === 'ai_unavailable') {
        setBlocked('unavailable');
      } else if (code === 'ai_pending') {
        toast.info(t('errors.pending'));
      } else if (code === 'ai_quota_exceeded') {
        toast.error(t('errors.quota'));
      } else {
        toast.error(errorMessage(error));
      }
    },
  });

  if (off) {
    return null;
  }
  const buttons: { task: AiTask; icon: typeof SparklesIcon }[] = [
    { task: 'summarize', icon: SparklesIcon },
    { task: 'classify', icon: TagIcon },
  ];
  return (
    <section
      aria-labelledby="ai-panel-title"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div>
        <h2 id="ai-panel-title" className="font-medium">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {blocked ? (
        <Alert role="alert">
          <CircleAlertIcon />
          <AlertDescription>{t(`errors.${blocked}`)}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          {buttons.map(({ task, icon: Icon }) => (
            <Button
              key={task}
              type="button"
              variant="outline"
              disabled={asking === task}
              onClick={() => ask.mutate(task)}
            >
              {asking === task ? <Spinner /> : <Icon />}
              {t(`actions.${task}`)}
            </Button>
          ))}
        </div>
      )}
      {buttons.map(({ task }) => {
        const id = runs[task];
        return id ? (
          <section key={task} aria-label={t(`actions.${task}`)}>
            <AiRunView id={id} task={task} />
          </section>
        ) : null;
      })}
    </section>
  );
}
