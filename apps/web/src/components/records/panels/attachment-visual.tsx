import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { cn } from 'cn';
import { DownloadIcon, FileIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadUrl, renditionUrl, type Attachment } from './api';

/** The square a file's picture is shown in, in CSS pixels (`size-14`). */
const TILE = 56;

const TILE_CLASS =
  'flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-muted-foreground';

/**
 * A rendition's size scaled to fit the tile, the proportions kept and never
 * enlarged: the `width` and `height` the API gives (`renditions.thumb`), so
 * the row has its size before the image has loaded.
 */
function fitTo(box: number, width: number, height: number) {
  const scale = Math.min(1, box / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The image's `preview` (1600 px at most) with the original one click away.
 * Mounted only while the dialog is open: the image is asked for when it is
 * looked at, and its loading state starts over each time.
 */
function PreviewImage(props: {
  attachment: Attachment;
  width: number;
  height: number;
}) {
  const { t } = useTranslation('records');
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  );
  return (
    <div className="relative flex min-h-40 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {state === 'failed' ? (
        <p role="alert" className="p-6 text-center text-sm text-destructive">
          {t('attachments.previewError')}
        </p>
      ) : (
        <img
          src={renditionUrl(props.attachment.id, 'preview')}
          alt={props.attachment.name}
          width={props.width}
          height={props.height}
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
          // `auto` sizes with the width and height above as the proportions:
          // as large as the dialog allows, never enlarged past the file's own.
          className="h-auto max-h-[70vh] w-auto max-w-full object-contain"
        />
      )}
      {state === 'loading' && (
        <Spinner
          aria-label={t('attachments.previewLoading')}
          className="absolute"
        />
      )}
    </div>
  );
}

/**
 * What a row shows of its file, in a square of one size so a list lines up:
 *
 * - an image whose renditions are `ready`: its `thumb`, which opens the
 *   `preview` in a dialog (the original stays one download away);
 * - an image still `pending`: a placeholder, until the realtime `processed`
 *   event or the next read says it is done;
 * - everything else, an image that `failed` included: the file icon.
 *
 * The thumbnail is asked for only when `renditionStatus` says `ready` (the
 * API answers 404 before, and 409 while the malware scan runs); one that does
 * not load (the redirect's origin refused, the copy gone) falls back to the
 * icon rather than a broken image. docs/attachments.md, "Image renditions".
 */
export function AttachmentVisual(props: { attachment: Attachment }) {
  const { t } = useTranslation('records');
  const { attachment } = props;
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);

  if (attachment.renditionStatus === 'ready' && !broken) {
    const { thumb, preview } = attachment.renditions;
    if (thumb) {
      const image = (
        <img
          src={renditionUrl(attachment.id, 'thumb')}
          alt=""
          {...fitTo(TILE, thumb.width, thumb.height)}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      );
      if (!preview) return <div className={TILE_CLASS}>{image}</div>;
      return (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('attachments.preview', { name: attachment.name })}
            className={cn(
              TILE_CLASS,
              'cursor-zoom-in outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
            )}
          >
            {image}
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              showCloseButton={false}
              className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
            >
              <DialogHeader>
                <DialogTitle className="truncate">
                  {attachment.name}
                </DialogTitle>
                <DialogDescription>
                  {t('attachments.previewNote')}
                </DialogDescription>
              </DialogHeader>
              <PreviewImage
                attachment={attachment}
                width={preview.width}
                height={preview.height}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  {t('attachments.close')}
                </Button>
                <a
                  href={downloadUrl(attachment.id)}
                  download={attachment.name}
                  className={buttonVariants()}
                >
                  <DownloadIcon />
                  {t('attachments.downloadOriginal')}
                </a>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      );
    }
  }

  if (attachment.renditionStatus === 'pending') {
    return (
      <Skeleton
        role="img"
        aria-label={t('attachments.preparing')}
        className="size-14 shrink-0 rounded-md border"
      />
    );
  }

  return (
    <div className={TILE_CLASS}>
      <FileIcon aria-hidden className="size-6" />
    </div>
  );
}
