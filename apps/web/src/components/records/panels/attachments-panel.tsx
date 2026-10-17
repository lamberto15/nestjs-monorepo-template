import { Button } from '@nestjs-monorepo-template/ui/components/button';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, LockIcon, UploadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { RelativeTime } from '@/features/notifications/relative-time';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import {
  downloadUrl,
  listAttachments,
  panelKeys,
  removeAttachment,
  uploadAttachment,
  type Attachment,
} from './api';

/**
 * ATTACHMENT_MAX_MB (25, env.example). The API does not publish its limits,
 * so this is the default; a deployment that changes it is still held to by
 * the API (413 `payload_too_large`, shown as the upload's error). The types
 * are not checked here either: the API reads them from the bytes
 * (415 `unsupported_media_type`).
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

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
function typeLabel(contentType: string) {
  const subtype = contentType.split('/')[1] ?? contentType;
  if (contentType === 'text/plain') return 'TXT';
  return (subtype.split(/[.+-]/).at(-1) ?? subtype).toUpperCase();
}

function UploadZone(props: { base: string; id: string; onDone: () => void }) {
  const { t, i18n } = useTranslation('records');
  const [files, setFiles] = useState<File[]>([]);
  return (
    <FileUpload
      value={files}
      onValueChange={setFiles}
      maxSize={ATTACHMENT_MAX_BYTES}
      multiple
      onFileReject={(file, message) =>
        toast.error(
          t('attachments.rejected', {
            name: file.name,
            reason:
              message === 'File too large'
                ? t('attachments.tooLarge', {
                    max: formatSize(ATTACHMENT_MAX_BYTES, i18n.language),
                  })
                : message,
          }),
        )
      }
      onUpload={async (batch, { onProgress, onSuccess, onError }) => {
        await Promise.all(
          batch.map(async (file) => {
            try {
              await uploadAttachment(props.base, props.id, file, (percent) =>
                onProgress(file, percent),
              );
              onSuccess(file);
              // Listed below now: the row leaves the upload list.
              setFiles((current) => current.filter((f) => f !== file));
            } catch (error) {
              toast.error(errorMessage(error));
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
          <p className="text-sm font-medium">{t('attachments.drop')}</p>
          <p className="text-xs text-muted-foreground">
            {t('attachments.limit', {
              max: formatSize(ATTACHMENT_MAX_BYTES, i18n.language),
            })}
          </p>
        </div>
        <FileUploadTrigger
          render={<Button variant="outline" size="sm" type="button" />}
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
  );
}

function AttachmentRow(props: {
  attachment: Attachment;
  canRemove: boolean;
  onRemoved: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation('records');
  const { attachment } = props;
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border p-3">
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
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{typeLabel(attachment.contentType)}</span>
          <span>{formatSize(attachment.size, i18n.language)}</span>
          <RelativeTime value={attachment.createdAt} />
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {/* The API answers with a redirect to a signed link (5 minutes) and
            names the file itself (Content-Disposition: attachment). */}
        <Button
          variant="outline"
          size="sm"
          render={
            <a
              href={downloadUrl(attachment.id)}
              download={attachment.name}
              aria-label={t('attachments.download', { name: attachment.name })}
            />
          }
        >
          <DownloadIcon />
          {t('attachments.downloadShort')}
        </Button>
        {props.canRemove && !attachment.locked && (
          <ConfirmButton
            variant="ghost"
            size="sm"
            title={t('attachments.deleteTitle')}
            description={t('attachments.deleteDescription', {
              name: attachment.name,
            })}
            confirm={t('attachments.delete')}
            onConfirm={async () => {
              await removeAttachment(attachment.id);
              await props.onRemoved();
            }}
          >
            {t('attachments.delete')}
          </ConfirmButton>
        )}
      </div>
    </li>
  );
}

/**
 * Files on the record: upload (who may change it), download (who may read it),
 * delete (the uploader, or who may change the record; never an issued document).
 */
export function AttachmentsPanel(props: {
  base: string;
  id: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const me = useMe()?.user.id;
  const key = panelKeys.attachments(props.base, props.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => listAttachments(props.base, props.id),
    refetchInterval: 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  return (
    <div className="flex flex-col gap-4">
      {props.canWrite && (
        <UploadZone
          base={props.base}
          id={props.id}
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
