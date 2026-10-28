import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  FileUploadTrigger,
} from '@nestjs-monorepo-template/ui/components/file-upload';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, LockIcon, UploadIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { RelativeTime } from '@/features/notifications/relative-time';
import { errorMessage } from '@/lib/errors';
import { useFeature, useMe } from '@/lib/features';
import { useRealtime, useRealtimeConnected } from '@/lib/realtime';
import { StoreRefusedError } from '@/lib/upload';
import {
  downloadUrl,
  listAttachments,
  panelKeys,
  removeAttachment,
  uploadAttachment,
  type Attachment,
} from './api';
import { AttachmentVisual } from './attachment-visual';

/**
 * What a file may be, as the upload route enforces it (`attachmentLimits` of
 * `GET /v1/lists/{subject}`: ATTACHMENT_MAX_MB, ATTACHMENT_ALLOWED_TYPES).
 */
export type AttachmentLimits = { maxBytes: number; types: readonly string[] };

/** "1.5 MB" in the UI's language. */
export function formatSize(bytes: number, language: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** The file's type for people: "PDF", "PNG"… from the detected MIME type. */
const OFFICE: Record<string, string> = {
  'wordprocessingml.document': 'DOCX',
  'spreadsheetml.sheet': 'XLSX',
  'presentationml.presentation': 'PPTX',
};

function typeLabel(contentType: string) {
  const subtype = contentType.split('/')[1] ?? contentType;
  if (contentType === 'text/plain') return 'TXT';
  const office = Object.entries(OFFICE).find(([end]) => subtype.endsWith(end));
  if (office) return office[1];
  return (subtype.split(/[.+-]/).at(-1) ?? subtype).toUpperCase();
}

/**
 * A file whose malware scan has not finished (`scanStatus` `pending`,
 * docs/attachments.md): the API answers its download with 409
 * `attachment_scan_pending`, so it is not offered.
 */
const isScanning = (attachment: Pick<Attachment, 'scanStatus'>) =>
  attachment.scanStatus === 'pending';

/**
 * An image whose thumbnail and preview are still being made
 * (`renditionStatus` `pending`, docs/attachments.md, "Image renditions"):
 * the original can be downloaded, and the row shows a placeholder.
 */
const isProcessing = (attachment: Pick<Attachment, 'renditionStatus'>) =>
  attachment.renditionStatus === 'pending';

/**
 * How often a list with a file waiting for a worker (the malware scan, an
 * image's renditions) is read again. Both jobs act as the system principal,
 * so `record.attachments.changed` (`scanned`, `processed`, `removed`)
 * reaches only the record's watchers, and an uploader who is not one never
 * hears of the job's end: the read is what settles their list (an infected
 * file's notification reloads it sooner, RecordPanels). Hence a short
 * interval even with a connected socket.
 */
const WORKER_POLL = { live: 10_000, offline: 5_000 } as const;

/** Why the browser refuses a file before the upload: `onFileValidate`'s answer. */
const TYPE_REFUSED = 'type';

/**
 * Files dragged anywhere over the record's page drop into the upload zone:
 * onto its file input, as the zone's own drop does (Dice UI's FileUpload),
 * so the same checks and messages apply. True while files are over the page.
 */
function usePageDrop(zone: RefObject<HTMLElement | null>) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes('Files') ?? false;
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return;
      }
      // Lets the drop land here instead of the browser opening the file.
      event.preventDefault();
      setOver(true);
    };
    const onLeave = (event: DragEvent) => {
      // Left the window (not just moved between elements).
      if (event.relatedTarget === null) {
        setOver(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      setOver(false);
      // Dropped on the zone itself: it took the files already.
      if (!hasFiles(event) || event.defaultPrevented || !event.dataTransfer) {
        return;
      }
      const input =
        zone.current?.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) {
        return;
      }
      event.preventDefault();
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [zone]);
  return over;
}

function UploadZone(props: {
  base: string;
  id: string;
  limits: AttachmentLimits;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation('records');
  const [files, setFiles] = useState<File[]>([]);
  // With STORAGE_DRIVER=s3 the file goes straight to the bucket, not through the API.
  const direct = useFeature('presignedUploads');
  const { maxBytes, types } = props.limits;
  const max = formatSize(maxBytes, i18n.language);
  const zone = useRef<HTMLDivElement>(null);
  const pageDrag = usePageDrop(zone);
  return (
    <div ref={zone}>
      {pageDrag && (
        // What a drop anywhere does; a picture for the one dragging (the
        // zone and its button say the same to everyone else).
        <div
          aria-hidden
          className="pointer-events-none fixed inset-4 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium"
        >
          {t('attachments.dropAnywhere')}
        </div>
      )}
      <FileUpload
        value={files}
        onValueChange={setFiles}
        maxSize={maxBytes}
        multiple
        // The API recognizes the type from the bytes; the browser guesses it
        // from the name. A file the browser names a type the API refuses is
        // refused here; one it can't name (empty type) goes to the API, which
        // decides (415). `accept` would refuse those too, so it's not used.
        onFileValidate={(file) =>
          file.type && types.length > 0 && !types.includes(file.type)
            ? TYPE_REFUSED
            : null
        }
        onFileReject={(file, message) =>
          toast.error(
            t('attachments.rejected', {
              name: file.name,
              reason:
                message === TYPE_REFUSED
                  ? t('attachments.typeRefused')
                  : message === 'File too large'
                    ? t('attachments.tooLarge', { max })
                    : message,
            }),
          )
        }
        onUpload={async (batch, { onProgress, onSuccess, onError }) => {
          await Promise.all(
            batch.map(async (file) => {
              try {
                await uploadAttachment(
                  props.base,
                  props.id,
                  file,
                  (percent) => onProgress(file, percent),
                  direct,
                );
                onSuccess(file);
                // Listed below now: the row leaves the upload list.
                setFiles((current) => current.filter((f) => f !== file));
              } catch (error) {
                toast.error(
                  error instanceof StoreRefusedError
                    ? t('attachments.storageFailed')
                    : errorMessage(error),
                );
                onError(file, error instanceof Error ? error : new Error());
              }
            }),
          );
          props.onDone();
        }}
      >
        <FileUploadDropzone>
          <div className="flex flex-col items-center gap-1 text-center">
            <UploadIcon className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium pointer-coarse:hidden">
              {t('attachments.drop')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('attachments.limit', {
                max,
                types: [...new Set(types.map(typeLabel))].join(', '),
              })}
            </p>
          </div>
          <FileUploadTrigger
            render={<Button variant="outline" size="sm" type="button" />}
            // A touch screen has nothing to drag: the button comes first, thumb-sized.
            className="pointer-coarse:order-first pointer-coarse:h-11 pointer-coarse:w-full"
          >
            {t('attachments.choose')}
          </FileUploadTrigger>
        </FileUploadDropzone>
        <FileUploadList>
          {files.map((file) => (
            <FileUploadItem
              key={`${file.name}-${file.size}-${file.lastModified}`}
              value={file}
            >
              <FileUploadItemPreview />
              <FileUploadItemMetadata />
              <FileUploadItemProgress />
              <FileUploadItemDelete
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={t('attachments.dismiss')}
                  />
                }
              >
                <XIcon />
              </FileUploadItemDelete>
            </FileUploadItem>
          ))}
        </FileUploadList>
      </FileUpload>
    </div>
  );
}

function AttachmentRow(props: {
  attachment: Attachment;
  canRemove: boolean;
  onRemoved: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation('records');
  const { attachment } = props;
  const scanning = isScanning(attachment);
  // A mutation, so a refusal reaches the global handler (the toast with the
  // problem's detail). Settled either way: a 404 or 409 means the list changed.
  const remove = useMutation({
    mutationFn: () => removeAttachment(attachment.id),
    onSettled: props.onRemoved,
  });
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <AttachmentVisual attachment={attachment} />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            {attachment.locked && (
              <LockIcon
                className="size-3.5 shrink-0"
                aria-label={t('attachments.locked')}
              />
            )}
            <span className="truncate">{attachment.name}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{typeLabel(attachment.contentType)}</span>
            <span>{formatSize(attachment.size, i18n.language)}</span>
            <RelativeTime value={attachment.createdAt} />
            {scanning && (
              // A status, so a screen reader hears it when the upload lands.
              <Badge variant="secondary" role="status">
                <Spinner
                  aria-hidden
                  role="presentation"
                  data-icon="inline-start"
                />
                {t('attachments.scanning')}
              </Badge>
            )}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {scanning ? (
          // Not a link: the download answers 409 until the scan is done.
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled
            aria-label={t('attachments.downloadScanning', {
              name: attachment.name,
            })}
          >
            <DownloadIcon />
            {t('attachments.downloadShort')}
          </Button>
        ) : (
          /* The API answers with a redirect to a signed link (5 minutes) and
             names the file itself (Content-Disposition: attachment). */
          <a
            href={downloadUrl(attachment.id)}
            download={attachment.name}
            aria-label={t('attachments.download', { name: attachment.name })}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <DownloadIcon />
            {t('attachments.downloadShort')}
          </a>
        )}
        {props.canRemove && !attachment.locked && (
          <ConfirmButton
            variant="ghost"
            size="sm"
            title={t('attachments.deleteTitle')}
            description={t('attachments.deleteDescription', {
              name: attachment.name,
            })}
            confirm={t('attachments.delete')}
            onConfirm={() => remove.mutateAsync()}
          >
            {t('attachments.delete')}
          </ConfirmButton>
        )}
      </div>
    </li>
  );
}

/**
 * Files on the record: upload (who may change it), download (who may read it,
 * once the malware scan is done: a file still being scanned says so and has
 * no link), delete (the uploader, or who may change the record; never an
 * issued document). A file found infected is deleted by the API: it leaves
 * the list on `record.attachments.changed` (`removed`, to the record's
 * watchers) or when its uploader's rejection notification arrives, and the
 * uploader is told (RecordPanels). An image shows its thumbnail once the
 * worker has made it (AttachmentVisual); `processed` reloads the list like
 * the other events.
 */
export function AttachmentsPanel(props: {
  base: string;
  id: string;
  canWrite: boolean;
  limits: AttachmentLimits;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const me = useMe()?.user.id;
  const live = useRealtime() !== undefined;
  const connected = useRealtimeConnected();
  const key = panelKeys.attachments(props.base, props.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => listAttachments(props.base, props.id),
    // `record.attachments.changed` reloads it (RecordPanels); polled only
    // without realtime, and while a file waits for a worker: its malware
    // scan or its image renditions (WORKER_POLL).
    refetchInterval: (q) =>
      q.state.data?.some((a) => isScanning(a) || isProcessing(a))
        ? connected
          ? WORKER_POLL.live
          : WORKER_POLL.offline
        : live
          ? false
          : 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  return (
    <div className="flex flex-col gap-4">
      {props.canWrite && (
        <UploadZone
          base={props.base}
          id={props.id}
          limits={props.limits}
          onDone={() => void refresh()}
        />
      )}
      {query.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('attachments.error')}
        </p>
      ) : query.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('attachments.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('attachments.title')}>
          {query.data.map((attachment) => (
            <AttachmentRow
              key={attachment.id}
              attachment={attachment}
              canRemove={
                props.canWrite || attachment.uploadedBy === `user:${me}`
              }
              onRemoved={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
