import { isApiError } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon, DownloadIcon, FileTextIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RelativeTime } from '@/features/notifications/relative-time';
import { errorMessage } from '@/lib/errors';
import { useFeatures, useMe } from '@/lib/features';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime';
import { toast } from 'sonner';
import {
  documentStatus,
  downloadUrl,
  issueDocument,
  listAttachments,
  panelKeys,
  type Attachment,
} from './api';
import { formatSize } from './attachments-panel';

/** A language by its own name ("Deutsch"), so a reader finds theirs. */
function languageName(code: string) {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The issued documents of a record: its locked PDF attachments. */
export const isIssued = (
  attachment: Pick<Attachment, 'locked' | 'contentType'>,
) => attachment.locked && attachment.contentType === 'application/pdf';

/**
 * One document being made: queued, rendering, then it joins the list (the
 * attachment) or it failed and says why. Follows the realtime events of the
 * panel; polled while it runs (slower with a socket, as a safety net).
 */
function PendingDocument(props: {
  id: string;
  base: string;
  recordId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation('documents');
  const queryClient = useQueryClient();
  const live = useRealtime() !== undefined;
  const query = useQuery({
    queryKey: panelKeys.document(props.id),
    queryFn: () => documentStatus(props.id),
    meta: { errorToast: false },
    refetchInterval: (q) =>
      q.state.data?.status === 'completed' || q.state.data?.status === 'failed'
        ? false
        : live
          ? 10_000
          : 1500,
  });
  const status = query.data?.status;
  const { base, recordId, onDone } = props;
  useEffect(() => {
    if (status === 'completed') {
      // Listed below now (the attachment); the job's row leaves.
      void queryClient.invalidateQueries({
        queryKey: panelKeys.attachments(base, recordId),
      });
      onDone();
    }
  }, [status, queryClient, base, recordId, onDone]);
  if (status === 'completed') {
    return null;
  }
  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlertIcon />
        <AlertDescription>{t('status.error')}</AlertDescription>
      </Alert>
    );
  }
  if (status === 'failed') {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlertIcon />
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>{query.data?.error ?? t('status.failed')}</span>
          <Button variant="ghost" size="sm" onClick={props.onDone}>
            {t('status.dismiss')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Progress
      value={null}
      aria-label={t('status.progressLabel')}
      className="flex-col"
    >
      <p role="status" className="text-sm text-muted-foreground">
        {status === 'rendering' ? t('status.rendering') : t('status.queued')}
      </p>
    </Progress>
  );
}

function DocumentRow(props: { attachment: Attachment }) {
  const { t, i18n } = useTranslation('documents');
  const me = useMe()?.user.id;
  const { attachment } = props;
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{attachment.name}</span>
        </p>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{formatSize(attachment.size, i18n.language)}</span>
          <span>
            {t('issuedAt')} <RelativeTime value={attachment.createdAt} />
          </span>
          <span>
            {attachment.uploadedBy === `user:${me}`
              ? t('byYou')
              : attachment.uploadedBy === 'anonymized'
                ? t('byAnonymized')
                : t('byOther')}
          </span>
        </p>
      </div>
      {/* A plain link: the API redirects to a signed link (5 minutes) and
          names the file (Content-Disposition: attachment), so the browser
          saves the PDF; nothing of it is shown inside the app. */}
      <a
        href={downloadUrl(attachment.id)}
        download={attachment.name}
        aria-label={t('download', { name: attachment.name })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        <DownloadIcon />
        {t('downloadShort')}
      </a>
    </li>
  );
}

/**
 * The record's PDF documents (docs/documents.md): the issued ones with a
 * download, a button to issue another in a language, and the jobs running.
 * 503 `documents_unavailable` (the feature is off or Gotenberg is down)
 * hides the button and says so.
 */
export function DocumentsPanel(props: { base: string; id: string }) {
  const { t, i18n } = useTranslation('documents');
  const queryClient = useQueryClient();
  const locales = useFeatures()?.locales ?? [];
  const [chosen, setChosen] = useState<string>();
  const lang =
    chosen ??
    (locales.includes(i18n.language as never) ? i18n.language : locales[0]) ??
    i18n.language;
  const [jobs, setJobs] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const key = panelKeys.attachments(props.base, props.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => listAttachments(props.base, props.id),
  });

  const settle = (event: { id: string; recordId: string }) => {
    if (event.recordId === props.id) {
      void queryClient.invalidateQueries({
        queryKey: panelKeys.document(event.id),
      });
    }
  };
  useRealtimeEvent('document.ready', settle);
  useRealtimeEvent('document.failed', settle);

  const join = (id: string) =>
    setJobs((current) => (current.includes(id) ? current : [...current, id]));
  const leave = (id: string) =>
    setJobs((current) => current.filter((j) => j !== id));
  const issue = useMutation({
    mutationFn: () => issueDocument(props.base, props.id, lang),
    meta: { errorToast: false },
    onSuccess: (started) => join(started.id),
    onError: (error) => {
      if (isApiError(error) && error.code === 'documents_unavailable') {
        setUnavailable(true);
      } else if (isApiError(error) && error.code === 'document_pending') {
        // Already being made in this language: follow that one.
        const id = (error.problem as { id?: string }).id;
        if (id) join(id);
        toast.info(t('pending'));
      } else {
        toast.error(errorMessage(error));
      }
    },
  });

  const issued = (query.data ?? []).filter(isIssued);
  return (
    <div className="flex flex-col gap-4">
      {unavailable ? (
        <Alert role="alert">
          <CircleAlertIcon />
          <AlertDescription>{t('unavailable')}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {locales.length > 1 && (
            <Field className="w-48">
              <FieldLabel htmlFor="document-language">
                {t('language')}
              </FieldLabel>
              <Select
                items={locales.map((code) => ({
                  value: code,
                  label: languageName(code),
                }))}
                value={lang}
                onValueChange={(value) => setChosen(value ?? undefined)}
              >
                <SelectTrigger id="document-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((code) => (
                    <SelectItem key={code} value={code}>
                      {languageName(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? <Spinner /> : <FileTextIcon />}
            {t('issue')}
          </Button>
        </div>
      )}
      {jobs.map((id) => (
        <PendingDocument
          key={id}
          id={id}
          base={props.base}
          recordId={props.id}
          onDone={() => leave(id)}
        />
      ))}
      {query.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      ) : issued.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('title')}>
          {issued.map((attachment) => (
            <DocumentRow key={attachment.id} attachment={attachment} />
          ))}
        </ul>
      )}
    </div>
  );
}
